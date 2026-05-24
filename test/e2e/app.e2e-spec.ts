/**
 * E2E test suite: E-01 through E-11
 *
 * Full HTTP stack via Supertest + embedded mock HCM server on port 4001.
 * Each test uses a unique employeeId so tests are isolated without DB truncation.
 *
 * CIRCUIT_BREAKER_VOLUME=20 prevents accidental circuit trips during the few
 * failure scenarios tested here (E-04, E-05, E-06 produce at most 3 errors).
 */

// Must be set before Test.createTestingModule is called (happens in beforeAll).
process.env['HCM_BASE_URL'] = 'http://localhost:4001';
process.env['HCM_TIMEOUT_MS'] = '500'; // short for fast timeout tests
process.env['CIRCUIT_BREAKER_THRESHOLD'] = '0.5';
process.env['CIRCUIT_BREAKER_VOLUME'] = '20'; // high — prevents accidental circuit open
process.env['CIRCUIT_BREAKER_RESET_TIMEOUT_MS'] = '30000';
process.env['PORT'] = '0';
process.env['LOG_FORMAT'] = 'json';
process.env['LOG_LEVEL'] = 'error';
process.env['DATABASE_PATH'] = ':memory:';

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module';
import {
  getCallLog,
  resetMockHcm,
  setBalance,
  setMode,
  startMockHcm,
  stopMockHcm,
} from '../mock-hcm';

const MOCK_HCM_PORT = 4001;
const LOC = 'LOC-E2E';

describe('ExampleHR E2E — E-01..E-11', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;

  // ──────────────────────────────────────────────────────────────────────────
  // Suite lifecycle
  // ──────────────────────────────────────────────────────────────────────────

  beforeAll(async () => {
    await startMockHcm('http://localhost:unused', MOCK_HCM_PORT);

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('v1');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
    http = request(app.getHttpServer());
  }, 30_000);

  afterAll(async () => {
    await app.close();
    await stopMockHcm();
  });

  beforeEach(() => {
    resetMockHcm(); // clears mock balances, mode, and call log
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Helpers
  // ──────────────────────────────────────────────────────────────────────────

  async function seedBalance(employeeId: string, available: number, total = 20): Promise<void> {
    const used = total - available;
    await http
      .post('/v1/hcm/sync/realtime')
      .send({ employeeId, locationId: LOC, available, used, total })
      .expect(201);
    setBalance({ employeeId, locationId: LOC, available, used, total });
  }

  async function submitRequest(
    employeeId: string,
    days: number,
    startDate = '2026-06-01',
    endDate = '2026-06-10',
  ) {
    return http
      .post('/v1/time-off-requests')
      .send({ employeeId, locationId: LOC, leaveType: 'VACATION', startDate, endDate, days });
  }

  async function getBalance(employeeId: string) {
    return http.get(`/v1/balances/${employeeId}/${LOC}`);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // E-01: Submit → Approve → Cancel — balance restored to original
  // ──────────────────────────────────────────────────────────────────────────
  it('E-01: Submit → Approve → Cancel; balance restored', async () => {
    await seedBalance('EMP-01', 10);

    const subRes = await submitRequest('EMP-01', 5);
    expect(subRes.status).toBe(201);
    expect(subRes.body.status).toBe('PENDING');
    const reqId = subRes.body.id as string;

    const approveRes = await http.patch(`/v1/time-off-requests/${reqId}/approve`);
    expect(approveRes.status).toBe(200);
    expect(approveRes.body.status).toBe('APPROVED');

    const balAfterApprove = await getBalance('EMP-01');
    expect(balAfterApprove.body.available).toBe(5);

    const cancelRes = await http.patch(`/v1/time-off-requests/${reqId}/cancel`);
    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body.status).toBe('CANCELLED');

    const balAfterCancel = await getBalance('EMP-01');
    expect(balAfterCancel.body.available).toBe(10);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // E-02: Submit → Reject — balance unchanged
  // ──────────────────────────────────────────────────────────────────────────
  it('E-02: Submit → Reject; balance unchanged', async () => {
    await seedBalance('EMP-02', 10);

    const subRes = await submitRequest('EMP-02', 3);
    expect(subRes.status).toBe(201);
    const reqId = subRes.body.id as string;

    const rejectRes = await http
      .patch(`/v1/time-off-requests/${reqId}/reject`)
      .send({ reason: 'No coverage' });
    expect(rejectRes.status).toBe(200);
    expect(rejectRes.body.status).toBe('REJECTED');

    const balRes = await getBalance('EMP-02');
    expect(balRes.body.available).toBe(10);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // E-03: Submit with zero available balance → 422 INSUFFICIENT_BALANCE
  // ──────────────────────────────────────────────────────────────────────────
  it('E-03: Submit with zero available balance → 422', async () => {
    await seedBalance('EMP-03', 0);

    const res = await submitRequest('EMP-03', 5);
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('INSUFFICIENT_BALANCE');
  });

  // ──────────────────────────────────────────────────────────────────────────
  // E-04: Approve with HCM rejection (reject-next) → 422 HCM_REJECTION; balance unchanged
  // ──────────────────────────────────────────────────────────────────────────
  it('E-04: Approve with HCM rejection; balance unchanged', async () => {
    await seedBalance('EMP-04', 10);
    const subRes = await submitRequest('EMP-04', 5);
    const reqId = subRes.body.id as string;

    setMode('reject-next');
    const approveRes = await http.patch(`/v1/time-off-requests/${reqId}/approve`);
    expect(approveRes.status).toBe(422);
    expect(approveRes.body.error).toBe('HCM_REJECTION');

    const balRes = await getBalance('EMP-04');
    expect(balRes.body.available).toBe(10);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // E-05: Approve with HCM timeout (timeout-next) → 503 HCM_UNAVAILABLE; balance unchanged
  // ──────────────────────────────────────────────────────────────────────────
  it('E-05: Approve with HCM timeout; 503 and balance unchanged', async () => {
    await seedBalance('EMP-05', 10);
    const subRes = await submitRequest('EMP-05', 5);
    const reqId = subRes.body.id as string;

    setMode('timeout-next');
    const approveRes = await http.patch(`/v1/time-off-requests/${reqId}/approve`);
    expect(approveRes.status).toBe(503);
    expect(approveRes.body.error).toBe('HCM_UNAVAILABLE');

    const balRes = await getBalance('EMP-05');
    expect(balRes.body.available).toBe(10);
  }, 10_000);

  // ──────────────────────────────────────────────────────────────────────────
  // E-06: Cancel with HCM timeout → 503; status stays APPROVED
  // ──────────────────────────────────────────────────────────────────────────
  it('E-06: Cancel with HCM timeout; status stays APPROVED', async () => {
    await seedBalance('EMP-06', 10);
    const subRes = await submitRequest('EMP-06', 5);
    const reqId = subRes.body.id as string;

    // Approve succeeds
    await http.patch(`/v1/time-off-requests/${reqId}/approve`).expect(200);

    // Set restore to persistent error so all retry attempts fail → 503
    setMode('error-always');
    const cancelRes = await http.patch(`/v1/time-off-requests/${reqId}/cancel`);
    expect(cancelRes.status).toBe(503);
    expect(cancelRes.body.error).toBe('HCM_UNAVAILABLE');

    // Request must remain APPROVED
    const getRes = await http.get(`/v1/time-off-requests/${reqId}`);
    expect(getRes.body.status).toBe('APPROVED');
  }, 12_000);

  // ──────────────────────────────────────────────────────────────────────────
  // E-07: Realtime webhook increases balance; previously-rejected submit now passes
  // ──────────────────────────────────────────────────────────────────────────
  it('E-07: Realtime push increases balance; approve now succeeds', async () => {
    await seedBalance('EMP-07', 3, 10); // 3 available, total 10

    // Submit 5 days → 422 (3 < 5)
    const failRes = await submitRequest('EMP-07', 5);
    expect(failRes.status).toBe(422);
    expect(failRes.body.error).toBe('INSUFFICIENT_BALANCE');

    // HCM pushes bonus: balance → 10
    setBalance({ employeeId: 'EMP-07', locationId: LOC, available: 10, used: 0, total: 10 });
    await http
      .post('/v1/hcm/sync/realtime')
      .send({ employeeId: 'EMP-07', locationId: LOC, available: 10, used: 0, total: 10 })
      .expect(201);

    // Now submit passes
    const subRes = await submitRequest('EMP-07', 5);
    expect(subRes.status).toBe(201);
    const reqId = subRes.body.id as string;

    // Approve succeeds
    await http.patch(`/v1/time-off-requests/${reqId}/approve`).expect(200);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // E-08: Realtime webhook drops balance; PENDING request → INVALIDATED
  // ──────────────────────────────────────────────────────────────────────────
  it('E-08: Realtime push drops balance; PENDING request → INVALIDATED', async () => {
    await seedBalance('EMP-08', 10, 10);

    const subRes = await submitRequest('EMP-08', 8);
    expect(subRes.status).toBe(201);
    const reqId = subRes.body.id as string;

    // HCM pushes balance down to 5 (below request's 8 days)
    const realtimeRes = await http
      .post('/v1/hcm/sync/realtime')
      .send({ employeeId: 'EMP-08', locationId: LOC, available: 5, used: 5, total: 10 });
    expect(realtimeRes.status).toBe(201);
    expect(realtimeRes.body.invalidated).toBe(1);

    const getRes = await http.get(`/v1/time-off-requests/${reqId}`);
    expect(getRes.body.status).toBe('INVALIDATED');
  });

  // ──────────────────────────────────────────────────────────────────────────
  // E-09: Batch sync updates 5 balances; 1 APPROVED request invalidated
  // ──────────────────────────────────────────────────────────────────────────
  it('E-09: Batch sync updates 5 balances; 1 APPROVED request invalidated', async () => {
    const loc = 'LOC-09';
    const employees = ['EMP-09A', 'EMP-09B', 'EMP-09C', 'EMP-09D', 'EMP-09E'];

    // Seed 5 employees (each with own location to avoid overlap detection conflicts)
    for (const eid of employees) {
      await http
        .post('/v1/hcm/sync/realtime')
        .send({ employeeId: eid, locationId: loc, available: 10, used: 0, total: 10 })
        .expect(201);
      setBalance({ employeeId: eid, locationId: loc, available: 10, used: 0, total: 10 });
    }

    // Submit + approve a request for EMP-09A (8 days)
    const subRes = await http
      .post('/v1/time-off-requests')
      .send({
        employeeId: 'EMP-09A',
        locationId: loc,
        leaveType: 'VACATION',
        startDate: '2026-06-01',
        endDate: '2026-06-08',
        days: 8,
      });
    expect(subRes.status).toBe(201);
    const approvedId = subRes.body.id as string;
    await http.patch(`/v1/time-off-requests/${approvedId}/approve`).expect(200);

    // Batch sync: drops EMP-09A balance to 1 (below approved 8 days)
    const batchRes = await http.post('/v1/hcm/sync/batch').send({
      balances: [
        { employeeId: 'EMP-09A', locationId: loc, available: 1, used: 9, total: 10 },
        { employeeId: 'EMP-09B', locationId: loc, available: 8, used: 2, total: 10 },
        { employeeId: 'EMP-09C', locationId: loc, available: 8, used: 2, total: 10 },
        { employeeId: 'EMP-09D', locationId: loc, available: 8, used: 2, total: 10 },
        { employeeId: 'EMP-09E', locationId: loc, available: 8, used: 2, total: 10 },
      ],
    });
    expect(batchRes.status).toBe(201);
    expect(batchRes.body.updated).toBe(5);
    expect(batchRes.body.invalidated).toBe(1);

    const getRes = await http.get(`/v1/time-off-requests/${approvedId}`);
    expect(getRes.body.status).toBe('INVALIDATED');
  });

  // ──────────────────────────────────────────────────────────────────────────
  // E-10: Concurrent approvals for same request → one 200, one conflict (409/422)
  // ──────────────────────────────────────────────────────────────────────────
  it('E-10: concurrent approve calls for same request → one 200, one conflict', async () => {
    // Exact balance = request size so the second concurrent HCM deduct gets 422 from mock
    await seedBalance('EMP-10', 5, 5);
    const subRes = await submitRequest('EMP-10', 5);
    expect(subRes.status).toBe(201);
    const reqId = subRes.body.id as string;

    // Fire two concurrent approve calls for the same request ID.
    // One will complete first (200 APPROVED); the other should see APPROVED status and
    // throw RequestConflictException (409), or see optimistic lock conflict (409).
    const [res1, res2] = await Promise.all([
      http.patch(`/v1/time-off-requests/${reqId}/approve`),
      http.patch(`/v1/time-off-requests/${reqId}/approve`),
    ]);

    const statuses = [res1.status, res2.status];
    expect(statuses).toContain(200);
    // The loser returns 409 (conflict) or 422 (insufficient balance on retry)
    const loserStatus = statuses.find(s => s !== 200);
    expect(loserStatus).toBeDefined();
    expect([409, 422]).toContain(loserStatus);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // E-11: HCM accept-all mode; local defensive check still rejects (C3 defense)
  // ──────────────────────────────────────────────────────────────────────────
  it('E-11: accept-all HCM mode; local check still blocks approve when balance = 0', async () => {
    await seedBalance('EMP-11', 10);

    // Submit while balance is sufficient
    const subRes = await submitRequest('EMP-11', 5);
    expect(subRes.status).toBe(201);
    const reqId = subRes.body.id as string;

    // Directly zero out the local balance without triggering reconciliation
    // (batch sync would invalidate the request, so we bypass it here)
    const ds = app.get(DataSource);
    await ds.query(
      `UPDATE balances SET available=0, version=version+1
       WHERE employee_id='EMP-11' AND location_id='${LOC}'`,
    );

    // Mock HCM is in accept-all mode — would accept any deduction
    setMode('accept-all');

    const approveRes = await http.patch(`/v1/time-off-requests/${reqId}/approve`);
    expect(approveRes.status).toBe(422);
    expect(approveRes.body.error).toBe('INSUFFICIENT_BALANCE');

    // No HCM deduct call should have been made
    const deductCalls = getCallLog().filter(e => e.path === '/hcm/deduct');
    expect(deductCalls).toHaveLength(0);
  });
});
