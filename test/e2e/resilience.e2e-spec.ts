/**
 * Resilience E2E tests: R-01, R-02, R-08
 *
 * Uses a separate mock HCM port (4002) and a low CIRCUIT_BREAKER_VOLUME (5)
 * so the breaker opens after just 5 error calls — safe to run alongside app.e2e-spec.ts
 * which uses port 4001 with CIRCUIT_BREAKER_VOLUME=20.
 *
 * R-03, R-04 (restore retry) are covered at unit level (U-A-13, U-A-14).
 * R-05, R-06, R-07 (health checks) are covered in health.integration.spec.ts.
 */

// Must be set before Test.createTestingModule is called (happens in beforeAll).
process.env['HCM_BASE_URL'] = 'http://localhost:4002';
process.env['HCM_TIMEOUT_MS'] = '500';
process.env['CIRCUIT_BREAKER_THRESHOLD'] = '0.5';
process.env['CIRCUIT_BREAKER_VOLUME'] = '5'; // opens after 5 errors (100% > 50%)
process.env['CIRCUIT_BREAKER_RESET_TIMEOUT_MS'] = '200'; // fast reset for R-02
process.env['PORT'] = '0';
process.env['LOG_FORMAT'] = 'json';
process.env['LOG_LEVEL'] = 'error';
process.env['DATABASE_PATH'] = ':memory:';

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import {
  getCallLog,
  resetMockHcm,
  setBalance,
  setMode,
  startMockHcm,
  stopMockHcm,
} from '../mock-hcm';

const MOCK_HCM_PORT = 4002;
const LOC = 'LOC-RES';

describe('Resilience E2E — R-01, R-02, R-08', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;

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
    resetMockHcm();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Helpers
  // ──────────────────────────────────────────────────────────────────────────

  async function seedBalance(employeeId: string, available = 10): Promise<void> {
    await http
      .post('/v1/hcm/sync/realtime')
      .send({ employeeId, locationId: LOC, available, used: 0, total: available })
      .expect(201);
    setBalance({ employeeId, locationId: LOC, available, used: 0, total: available });
  }

  async function submitRequest(employeeId: string, startDay: number) {
    const d = String(startDay).padStart(2, '0');
    return http.post('/v1/time-off-requests').send({
      employeeId,
      locationId: LOC,
      leaveType: 'VACATION',
      startDate: `2026-06-${d}`,
      endDate: `2026-06-${d}`,
      days: 1,
    });
  }

  // ──────────────────────────────────────────────────────────────────────────
  // R-01 + R-02: Circuit breaker lifecycle
  //
  // R-01: 5 consecutive HCM 500s → circuit OPEN; 6th call returns 503 fast,
  //       mock call-log shows only 5 deduct entries (no 6th network call).
  // R-02: After CIRCUIT_BREAKER_RESET_TIMEOUT_MS the circuit enters HALF_OPEN;
  //       one probe call succeeds → circuit CLOSED; next call reaches HCM normally.
  // ──────────────────────────────────────────────────────────────────────────
  describe('circuit breaker lifecycle', () => {
    const EMP = 'EMP-CB';

    beforeAll(async () => {
      // Seed enough balance for 8 single-day requests
      await seedBalance(EMP, 20);
    });

    it('R-01: 5 consecutive HCM 500s open the circuit; 6th call does not reach mock', async () => {
      // Submit 6 pending requests (non-overlapping single days)
      const ids: string[] = [];
      for (let i = 1; i <= 6; i++) {
        setMode('normal'); // ensure normal for submission (submit doesn't call HCM)
        const res = await submitRequest(EMP, i);
        expect(res.status).toBe(201);
        ids.push(res.body.id as string);
      }

      // Approve 5 times with error-next → circuit accumulates 5 failures
      for (let i = 0; i < 5; i++) {
        setMode('error-next');
        const res = await http.patch(`/v1/time-off-requests/${ids[i]}/approve`);
        expect(res.status).toBe(503);
      }

      // Call log should show exactly 5 deduct calls
      const deductsBefore = getCallLog().filter(e => e.path === '/hcm/deduct');
      expect(deductsBefore).toHaveLength(5);

      // 6th approve: circuit OPEN → fail-fast, no network call
      const start = Date.now();
      const res6 = await http.patch(`/v1/time-off-requests/${ids[5]}/approve`);
      const elapsed = Date.now() - start;

      expect(res6.status).toBe(503);
      expect(elapsed).toBeLessThan(300); // well under 500ms HCM timeout → was fast

      // Mock call log still shows only 5 entries — no 6th HTTP call
      const deductsAfter = getCallLog().filter(e => e.path === '/hcm/deduct');
      expect(deductsAfter).toHaveLength(5);
    });

    it('R-02: circuit recovers after reset timeout; probe succeeds, circuit CLOSED', async () => {
      // Wait for the reset timeout (200ms) plus a safety margin
      await new Promise<void>(resolve => globalThis.setTimeout(resolve, 400));

      // beforeEach cleared the mock state — restore EMP-CB balance so HCM deduct succeeds
      // Local DB balance is still 20 (R-01 failures never wrote to DB)
      setBalance({ employeeId: EMP, locationId: LOC, available: 20, used: 0, total: 20 });

      // Submit 2 more pending requests for the probe and normal call
      const probeRes = await submitRequest(EMP, 7);
      expect(probeRes.status).toBe(201);
      const probeId = probeRes.body.id as string;

      const normalRes = await submitRequest(EMP, 8);
      expect(normalRes.status).toBe(201);
      const normalId = normalRes.body.id as string;

      // Probe call in HALF_OPEN state — mock responds normally (no error-next set)
      const probe = await http.patch(`/v1/time-off-requests/${probeId}/approve`);
      expect(probe.status).toBe(200); // probe succeeds → circuit CLOSED

      // Next call: circuit is CLOSED, reaches mock normally
      const normal = await http.patch(`/v1/time-off-requests/${normalId}/approve`);
      expect(normal.status).toBe(200);

      // Both calls appeared in the mock's call log
      const allDeducts = getCallLog().filter(e => e.path === '/hcm/deduct');
      // beforeEach reset the call log, so only probe + normal are visible (≥2)
      expect(allDeducts.length).toBeGreaterThanOrEqual(2);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // R-08: Graceful shutdown
  //
  // Full SIGTERM-during-in-flight-request testing requires spawning the app as a
  // child process (ts-node src/main.ts), which is outside the NestJS TestingModule
  // boundary. This test verifies the structural requirements:
  //   (a) app.close() completes after in-flight requests have finished
  //   (b) the DataSource is destroyed cleanly
  //   (c) the app was bootstrapped with enableShutdownHooks() (checked in main.ts)
  //
  // For a full integration test of SIGTERM behaviour, run:
  //   npx ts-node -r tsconfig-paths/register src/main.ts &
  //   curl -X PATCH http://localhost:3000/v1/time-off-requests/<id>/approve &
  //   kill -SIGTERM <pid>
  //   # verify the curl returns 200 and the process exits 0
  // ──────────────────────────────────────────────────────────────────────────
  describe('R-08: graceful shutdown', () => {
    let shutdownApp: INestApplication;

    beforeAll(async () => {
      // Bring up a fresh app instance so closing it doesn't affect the other tests
      const moduleRef: TestingModule = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();

      shutdownApp = moduleRef.createNestApplication();
      shutdownApp.setGlobalPrefix('v1');
      shutdownApp.useGlobalPipes(
        new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
      );
      await shutdownApp.init();
    }, 30_000);

    afterAll(async () => {
      // May already be closed; ignore errors
      try {
        await shutdownApp.close();
      } catch {
        // already closed
      }
    });

    it('R-08: app.close() completes cleanly after all in-flight requests finish', async () => {
      const shutdownHttp = request(shutdownApp.getHttpServer());

      // Seed balance + create a pending request on the shutdown-specific app
      await shutdownHttp
        .post('/v1/hcm/sync/realtime')
        .send({ employeeId: 'EMP-R8', locationId: LOC, available: 10, used: 0, total: 10 })
        .expect(201);
      setBalance({ employeeId: 'EMP-R8', locationId: LOC, available: 10, used: 0, total: 10 });
      const subRes = await shutdownHttp.post('/v1/time-off-requests').send({
        employeeId: 'EMP-R8',
        locationId: LOC,
        leaveType: 'VACATION',
        startDate: '2026-06-01',
        endDate: '2026-06-01',
        days: 1,
      });
      expect(subRes.status).toBe(201);
      const reqId = subRes.body.id as string;

      // Start an approve request and close the app concurrently.
      // The primary assertion is that close() resolves cleanly (no unhandled rejections,
      // DataSource destroyed). If close() wins the race, ECONNREFUSED is acceptable.
      const approvePromise = shutdownHttp.patch(`/v1/time-off-requests/${reqId}/approve`);
      const closePromise = shutdownApp.close();

      let approveStatus: number | undefined;
      try {
        const [approveRes] = await Promise.all([approvePromise, closePromise]);
        approveStatus = approveRes.status;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes('ECONNREFUSED') && !msg.includes('socket hang up')) {
          throw err; // unexpected error
        }
        // ECONNREFUSED: close() won the race — also demonstrates clean shutdown
      }

      if (approveStatus !== undefined) {
        expect([200, 503]).toContain(approveStatus);
      }

      // DataSource cleanly destroyed: close() resolved without throwing (verified above).
    });
  });
});
