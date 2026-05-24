# F-04 HCM sync: adapter interface + HTTP client — Tasks

**Feature:** F-04 — HCM sync: adapter interface + HTTP client
**Milestone:** M3 — Integration tests pass with mock HCM
**Status:** Done ✅
**Refs:** `docs/TRD.md`, `docs/RESILIENCE.md`, `docs/CLEAN_CODE.md`, `docs/ERROR_HANDLING.md`, `docs/TEST_STRATEGY.md`

> **Note:** This file will also hold F-05 tasks (realtime webhook + batch ingest + reconciliation) once F-04 is done.

---

## Scope

F-04 delivers the concrete HTTP client that fulfils `IHcmAdapter` and wires it into the NestJS DI graph:

- `HcmAdapterService` — raw-axios implementation of `IHcmAdapter` (deduct, restore, ping)
- Error mapping: 4xx → `HcmRejectionException`; timeout / 5xx / network → `HcmUnavailableException`
- Idempotency key header (`X-Idempotency-Key: {requestId}-{operation}`) on every mutating call
- `HcmSyncModule` updated to provide `HCM_ADAPTER_TOKEN → HcmAdapterService`
- `TimeOffRequestsModule` updated to import `HcmSyncModule` (resolves `HCM_ADAPTER_TOKEN` in production)
- Unit tests U-A-01..U-A-08

**Out of scope for F-04:**
- Circuit breaker (F-06)
- Retry / exponential backoff (F-06)
- `HcmSyncService`, realtime webhook, batch ingest, reconciliation (F-05)
- E2E tests (F-09)

---

## Key Design Decisions

### Raw axios (no @nestjs/axios)

`axios` is already a direct dependency. `HcmAdapterService` creates a configured `AxiosInstance` in its constructor via `axios.create({ baseURL, timeout })`. No `HttpModule` / `HttpService` wrapper is needed.

**Consequence for testing:** unit tests mock `axios.create` at the module level and control the returned instance's `post` / `get` methods via `jest.fn()`.

### Idempotency key convention (AD-009)

```
X-Idempotency-Key: {idempotencyKey}-approve   ← deduct
X-Idempotency-Key: {idempotencyKey}-cancel    ← restore
```

The caller passes the request UUID as `idempotencyKey`; the adapter appends the operation suffix. The full key is included in every call even before retry is enabled (B-002).

### Error mapping strategy

| Axios outcome | Condition | Thrown |
|---|---|---|
| HTTP 4xx response | `err.response.status >= 400 && < 500` | `HcmRejectionException(err.response.data?.message)` |
| HTTP 5xx response | `err.response.status >= 500` | `HcmUnavailableException(idempotencyKey)` |
| Timeout | `err.code === 'ECONNABORTED'` | `HcmUnavailableException(idempotencyKey)` |
| Network error (no response) | `!err.response` | `HcmUnavailableException(idempotencyKey)` |

`restore()` maps ALL errors to `HcmUnavailableException` (4xx included) — consistent with F-03 cancel flow which only handles `HcmUnavailableException`. `ping()` never throws; any error → `false`.

### HCM endpoint paths (B-001 workaround)

Using assumed paths that match the mock-hcm server spec until real HCM API shape is confirmed:

| Method | Path |
|---|---|
| deduct | `POST /hcm/deduct` |
| restore | `POST /hcm/restore` |
| ping | `GET /health` |

Update `HcmAdapterService` and mock server to match when B-001 is resolved.

### Module wiring

`HcmSyncModule` provides `{ provide: HCM_ADAPTER_TOKEN, useClass: HcmAdapterService }` and exports `HCM_ADAPTER_TOKEN`. `TimeOffRequestsModule` imports `HcmSyncModule`. Existing integration tests provide `HCM_ADAPTER_TOKEN` directly as a mock (they do not import `TimeOffRequestsModule`), so no test changes are needed.

---

## Execution Plan

All three tasks are sequential — each depends on the previous.

```
T1 (HcmAdapterService + unit tests)
  └── T2 (HcmSyncModule wiring)
       └── T3 (TimeOffRequestsModule wiring + build verification)
```

No parallel execution is possible.

---

## Task Breakdown

---

### T1: `HcmAdapterService` + unit tests U-A-01..U-A-08

**What:** Implement the concrete axios-based HTTP client that satisfies `IHcmAdapter`. Write 8 unit tests (RED → GREEN). Service and tests land in the same commit.

**Where:**
- `src/hcm-sync/adapters/hcm-adapter.service.ts` — new (CLEAN_CODE.md §3 mandates `adapters/` subdir)
- `test/unit/hcm-adapter.service.spec.ts` — new

**Depends on:** F-03 complete (port `src/hcm-sync/ports/hcm-adapter.port.ts` exists with `IHcmAdapter`, `HcmBalanceResponse`, `HCM_ADAPTER_TOKEN`)
**Requirement:** TRD §3.4, RESILIENCE.md §3 (timeout), AD-008 (DI), AD-009 (idempotency key)

**Implementation spec:**

```typescript
@Injectable()
export class HcmAdapterService implements IHcmAdapter {
  private readonly client: AxiosInstance;

  constructor(private readonly config: ConfigService) {
    this.client = axios.create({
      baseURL: config.get<string>('HCM_BASE_URL'),
      timeout: config.get<number>('HCM_TIMEOUT_MS', 5000),
    });
  }

  async deduct(employeeId, locationId, days, idempotencyKey): Promise<HcmBalanceResponse> {
    try {
      const { data } = await this.client.post('/hcm/deduct',
        { employeeId, locationId, days },
        { headers: { 'X-Idempotency-Key': `${idempotencyKey}-approve` } },
      );
      return data;
    } catch (err) {
      this.mapDeductError(err, idempotencyKey);
    }
  }

  async restore(employeeId, locationId, days, idempotencyKey): Promise<HcmBalanceResponse> {
    try {
      const { data } = await this.client.post('/hcm/restore',
        { employeeId, locationId, days },
        { headers: { 'X-Idempotency-Key': `${idempotencyKey}-cancel` } },
      );
      return data;
    } catch (err) {
      throw new HcmUnavailableException(idempotencyKey);
    }
  }

  async ping(): Promise<boolean> {
    try {
      await this.client.get('/health');
      return true;
    } catch {
      return false;
    }
  }

  private mapDeductError(err: unknown, traceId: string): never {
    if (axios.isAxiosError(err) && err.response && err.response.status < 500) {
      throw new HcmRejectionException(err.response.data?.message ?? 'HCM rejected the operation');
    }
    throw new HcmUnavailableException(traceId);
  }
}
```

**Unit test mock strategy:**

```typescript
// top of spec file — mock before imports resolve
jest.mock('axios', () => {
  const mockPost = jest.fn();
  const mockGet = jest.fn();
  return {
    create: jest.fn(() => ({ post: mockPost, get: mockGet })),
    isAxiosError: jest.fn((err) => err?.__isAxiosError === true),
    __mockPost: mockPost,
    __mockGet: mockGet,
  };
});
import axios from 'axios';

// helper to build AxiosError
function axiosError(status?: number, message?: string): object {
  return {
    __isAxiosError: true,
    response: status ? { status, data: { message } } : undefined,
    code: status ? undefined : 'ECONNABORTED',
  };
}
```

**Unit test cases:**

| ID | Method | Scenario | Mock setup | Expected |
|----|--------|----------|------------|----------|
| U-A-01 | `deduct()` | HCM returns 200 | `mockPost.mockResolvedValue({ data: { employeeId, locationId, available, used, total } })` | Returns `HcmBalanceResponse`; `post` called with `X-Idempotency-Key: req-01-approve` |
| U-A-02 | `deduct()` | HCM returns 422 (client error) | `mockPost.mockRejectedValue(axiosError(422, 'invalid leave type'))` | Throws `HcmRejectionException` with message containing `'invalid leave type'` |
| U-A-03 | `deduct()` | HCM returns 500 | `mockPost.mockRejectedValue(axiosError(500))` | Throws `HcmUnavailableException` |
| U-A-04 | `deduct()` | Timeout (ECONNABORTED) | `mockPost.mockRejectedValue(axiosError())` (no response, code=ECONNABORTED) | Throws `HcmUnavailableException` |
| U-A-05 | `restore()` | HCM returns 200 | `mockPost.mockResolvedValue({ data: { employeeId, locationId, available, used, total } })` | Returns `HcmBalanceResponse`; `post` called with `X-Idempotency-Key: req-01-cancel` |
| U-A-06 | `restore()` | Any error (4xx or 5xx) | `mockPost.mockRejectedValue(axiosError(503))` | Throws `HcmUnavailableException` (no `HcmRejectionException` — restore maps ALL errors to unavailable) |
| U-A-07 | `ping()` | HCM responds 200 | `mockGet.mockResolvedValue({ status: 200 })` | Returns `true`; no exception |
| U-A-08 | `ping()` | Network error | `mockGet.mockRejectedValue(new Error('ECONNREFUSED'))` | Returns `false`; no exception thrown |

**Done when:**
- [ ] `src/hcm-sync/hcm-adapter.service.ts` exists, `@Injectable()`, implements `IHcmAdapter`
- [ ] `constructor(private readonly config: ConfigService)` — axios instance created in constructor
- [ ] `deduct()` sets `X-Idempotency-Key: {key}-approve` header
- [ ] `restore()` sets `X-Idempotency-Key: {key}-cancel` header
- [ ] 4xx in `deduct()` → `HcmRejectionException`; 5xx/timeout → `HcmUnavailableException`
- [ ] Any error in `restore()` → `HcmUnavailableException`
- [ ] `ping()` returns `true` on success; `false` on any error (never throws)
- [ ] All 8 unit tests U-A-01..U-A-08 confirmed FAILING before implementation (RED)
- [ ] All 8 unit tests pass (GREEN)
- [ ] Gate check passes: `npm run test -- --testPathPattern=hcm-adapter.service.spec`
- [ ] Test count: **8 tests pass** (no silent deletions)
- [ ] `npm run build` exits 0

**Tests:** unit (U-A-01..U-A-08)
**Gate:** quick — `npm run test -- --testPathPattern=hcm-adapter.service.spec`

**Commit:** `feat(hcm-sync): implement HcmAdapterService with axios HTTP client and error mapping`

---

### T2: `HcmSyncModule` — provide `HCM_ADAPTER_TOKEN`

**What:** Update the empty `HcmSyncModule` stub to declare `HcmAdapterService` as the provider for `HCM_ADAPTER_TOKEN` and export the token so other modules can consume it.

**Where:**
- `src/hcm-sync/hcm-sync.module.ts` — modify (currently empty stub)

**Depends on:** T1

**Implementation:**

```typescript
import { Module } from '@nestjs/common';
import { HcmAdapterService } from './hcm-adapter.service';
import { HCM_ADAPTER_TOKEN } from './ports/hcm-adapter.port';

@Module({
  providers: [{ provide: HCM_ADAPTER_TOKEN, useClass: HcmAdapterService }],
  exports: [HCM_ADAPTER_TOKEN],
})
export class HcmSyncModule {}
```

`ConfigModule` is already global (`isGlobal: true` in `AppModule`) so `ConfigService` resolves without importing `ConfigModule` here.

**Done when:**
- [ ] `HcmSyncModule` providers: `{ provide: HCM_ADAPTER_TOKEN, useClass: HcmAdapterService }`
- [ ] `HcmSyncModule` exports: `[HCM_ADAPTER_TOKEN]`
- [ ] Gate check passes: `npm run build` exits 0

**Tests:** none (module wiring only — no business logic)
**Gate:** build — `npm run build`

**Commit:** `feat(hcm-sync): wire HcmAdapterService as HCM_ADAPTER_TOKEN provider`

---

### T3: `TimeOffRequestsModule` — import `HcmSyncModule` + verify

**What:** Add `HcmSyncModule` to `TimeOffRequestsModule`'s imports so that `TimeOffRequestsService` receives the real `HcmAdapterService` via `HCM_ADAPTER_TOKEN` in production. Verify build passes and existing integration tests are unaffected.

**Where:**
- `src/time-off-requests/time-off-requests.module.ts` — modify

**Depends on:** T2

**Implementation:**

```typescript
@Module({
  imports: [
    TypeOrmModule.forFeature([TimeOffRequest]),
    BalancesModule,
    HcmSyncModule,   // ← add
  ],
  providers: [TimeOffRequestsService],
  exports: [TimeOffRequestsService],
})
export class TimeOffRequestsModule {}
```

**Why existing integration tests are unaffected:** `test/integration/time-off-requests.integration.spec.ts` assembles its own flat `TestingModule` — it does not import `TimeOffRequestsModule` and provides `HCM_ADAPTER_TOKEN` directly as a mock. Adding `HcmSyncModule` to the real module has no effect on that test module.

**Done when:**
- [ ] `TimeOffRequestsModule` imports include `HcmSyncModule`
- [ ] `npm run build` exits 0
- [ ] Existing integration tests I-01 + I-02 still pass: `npm run test -- --testPathPattern=time-off-requests.integration.spec` exits 0, **2 tests pass**
- [ ] All 8 unit tests from T1 still pass: `npm run test -- --testPathPattern=hcm-adapter.service.spec` exits 0

**Tests:** integration (verify existing I-01, I-02 unaffected)
**Gate:** full — `npm run test -- --testPathPattern=time-off-requests.integration.spec`

**Commit:** `feat(time-off-requests): import HcmSyncModule to resolve HCM_ADAPTER_TOKEN`

---

## Parallel Execution Map

```
Phase 1 (Sequential — each task depends on the previous):
  T1 (HcmAdapterService + unit tests)
    └── T2 (HcmSyncModule wiring)
         └── T3 (TimeOffRequestsModule wiring + verify)
```

No parallel phases. All tasks are strictly sequential.

---

## Validation Report (F-04)

### Check 1: Task Granularity

| Task | Scope | Status |
|------|-------|--------|
| T1: HcmAdapterService + unit tests | 1 service file + 1 test file | ✅ Granular |
| T2: HcmSyncModule wiring | 1 module file (5 lines) | ✅ Granular |
| T3: TimeOffRequestsModule wiring | 1 module file (1 line added) | ✅ Granular |

### Check 2: Diagram-Definition Cross-Check

| Task | Depends On (body) | Diagram Shows | Status |
|------|-------------------|---------------|--------|
| T1 | F-03 complete | Start of chain | ✅ Match |
| T2 | T1 | T1 → T2 | ✅ Match |
| T3 | T2 | T2 → T3 | ✅ Match |

No tasks are marked `[P]`; no parallel dependency conflicts possible. ✅

### Check 3: Test Co-location Validation

Source: `docs/TEST_STRATEGY.md` — "service-layer business logic" requires unit tests; "error mapping" is explicitly called out as a unit test focus area.

| Task | Code Layer Created/Modified | TEST_STRATEGY Requires | Task Says | Status |
|------|-----------------------------|-----------------------|-----------|--------|
| T1: HcmAdapterService | Service (HTTP client + error mapping) | Unit | Unit (U-A-01..U-A-08) | ✅ Match |
| T2: HcmSyncModule | Module wiring (no logic) | None | none | ✅ OK |
| T3: TimeOffRequestsModule | Module wiring (no logic) | None | Integration (verify existing pass) | ✅ OK (conservative — no new tests, existing verified) |

No deferred tests. All service-layer code has co-located unit tests. ✅

---

---

# F-05 HCM sync: realtime webhook + batch ingest + reconciliation — Tasks

**Feature:** F-05 — HCM sync: realtime webhook + batch ingest + reconciliation
**Milestone:** M3 — Integration tests pass with mock HCM
**Status:** Done ✅
**Refs:** `docs/TRD.md`, `docs/ARCHITECTURE.md`, `docs/CLEAN_CODE.md`, `docs/ERROR_HANDLING.md`, `docs/TEST_STRATEGY.md`

---

## Scope

F-05 delivers `HcmSyncService` — the in-process handler for two inbound balance-change paths:

- **`handleRealtimeUpdate(dto)`** — single balance pushed by HCM webhook; upserts balance, writes `sync_log` entry if available changed, then invalidates any in-flight PENDING/APPROVED requests whose `days` would now exceed the new balance.
- **`handleBatchSync(dto)`** — full balance dump from HCM; all upserts run in a single TypeORM transaction, then one reconciliation JOIN query invalidates any PENDING/APPROVED requests across all employees whose balance assumption is now stale.

Also wires `HcmSyncModule` to provide `HcmSyncService` and confirms module compiles correctly.

**Out of scope for F-05:**
- HTTP controllers / routing (F-07)
- Circuit breaker / retry (F-06)
- E2E tests (F-09)

---

## Key Design Decisions

### Injection shape for `HcmSyncService`

```typescript
constructor(
  @InjectRepository(Balance)
  private readonly balanceRepo: Repository<Balance>,
  @InjectRepository(TimeOffRequest)
  private readonly requestRepo: Repository<TimeOffRequest>,
  private readonly syncLogService: SyncLogService,
  private readonly dataSource: DataSource,
) {}
```

`DataSource` is needed so `handleBatchSync` can open a transaction. `DataSource` is provided by `TypeOrmModule.forRoot`; no extra injection token is required.

### Balance upsert via `save()` + composite PK

`Balance` has a composite `@PrimaryColumn` pair `(employeeId, locationId)`. TypeORM's `save()` performs an INSERT OR REPLACE when the PK already exists — no custom upsert query needed.

Updated fields on every save: `available`, `used`, `total`, `version` (previous + 1), `lastSyncedAt` (current timestamp).

### Sync-log delta guard (idempotency rule I-04)

Write a `sync_log` row **only when `previousAvailable !== dto.available`**. A re-run of the same batch payload will still bump `version` and `lastSyncedAt` on the balance row (harmless), but won't produce duplicate `sync_log` rows.

For a brand-new balance (no existing row), treat `previousAvailable = 0`; if `dto.available !== 0`, a log row is written.

### Batch uses `manager.save(SyncLog, ...)` — not `syncLogService.append()`

`SyncLogService.append()` holds its own `Repository` reference that is outside the batch transaction. Inside a `dataSource.transaction()` callback, all writes must go through the `EntityManager` passed to the callback. This means the batch path writes `SyncLog` rows directly via `manager.save(SyncLog, ...)`.

The realtime path uses `syncLogService.append()` normally (no transaction wrapper needed).

### Invalidation query scope

- **Realtime**: filters by `{ employeeId, locationId }` of the updated balance — only requests for that employee/location pair.
- **Batch**: one JOIN query across the entire `time_off_requests` table after all balances are updated; avoids N per-employee queries.

Invalidation condition: `request.days > balance.available` (strict greater-than). Requests with `days === balance.available` are NOT invalidated.

### INVALIDATION `sync_log` entry

When a request is invalidated, an `INVALIDATION` log entry is written per request:
- `source`: `SyncSource.INVALIDATION`
- `previousAvailable` / `newAvailable`: the balance `available` at time of invalidation (same value — balance did not change during this step)
- `requestId`: the invalidated request's UUID
- `actor`: `'hcm-sync'`

---

## Execution Plan

All three tasks are strictly sequential.

```
T4 (HcmSyncService skeleton + handleRealtimeUpdate + unit tests U-S-01..U-S-05)
  └── T5 (add handleBatchSync + unit tests U-S-06..U-S-08)
       └── T6 (HcmSyncModule wiring + integration tests I-04, I-05)
```

---

## Task Breakdown

---

### T4: `HcmSyncService` + `handleRealtimeUpdate()` + unit tests U-S-01..U-S-05

**What:** Create `HcmSyncService` with the realtime update handler. Write 5 unit tests (RED → GREEN).

**Where:**
- `src/hcm-sync/hcm-sync.service.ts` — new
- `test/unit/hcm-sync.service.spec.ts` — new

**Depends on:** T3 complete (F-04 done), SyncLogService + entities exist

**Implementation spec:**

```typescript
export interface RealtimeUpdateDto {
  employeeId: string;
  locationId: string;
  available: number;
  used: number;
  total: number;
}

export interface SyncResult {
  updated: number;
  invalidated: number;
}

@Injectable()
export class HcmSyncService {
  constructor(
    @InjectRepository(Balance)  private readonly balanceRepo: Repository<Balance>,
    @InjectRepository(TimeOffRequest) private readonly requestRepo: Repository<TimeOffRequest>,
    private readonly syncLogService: SyncLogService,
    private readonly dataSource: DataSource,
  ) {}

  async handleRealtimeUpdate(dto: RealtimeUpdateDto): Promise<SyncResult> {
    const existing = await this.balanceRepo.findOneBy({ employeeId: dto.employeeId, locationId: dto.locationId });
    const previousAvailable = existing?.available ?? 0;

    await this.balanceRepo.save({
      ...dto,
      version: (existing?.version ?? 0) + 1,
      lastSyncedAt: new Date(),
    });

    if (previousAvailable !== dto.available) {
      await this.syncLogService.append({
        employeeId: dto.employeeId,
        locationId: dto.locationId,
        source: SyncSource.REALTIME_WEBHOOK,
        previousAvailable,
        newAvailable: dto.available,
        actor: 'hcm-webhook',
        requestId: null,
      });
    }

    // Invalidate PENDING/APPROVED requests where days > new balance
    const candidates = await this.requestRepo.find({
      where: [
        { employeeId: dto.employeeId, locationId: dto.locationId, status: RequestStatus.PENDING },
        { employeeId: dto.employeeId, locationId: dto.locationId, status: RequestStatus.APPROVED },
      ],
    });
    const toInvalidate = candidates.filter(r => r.days > dto.available);

    for (const req of toInvalidate) {
      req.status = RequestStatus.INVALIDATED;
      await this.requestRepo.save(req);
      await this.syncLogService.append({
        employeeId: req.employeeId,
        locationId: req.locationId,
        source: SyncSource.INVALIDATION,
        previousAvailable: dto.available,
        newAvailable: dto.available,
        actor: 'hcm-sync',
        requestId: req.id,
      });
    }

    return { updated: 1, invalidated: toInvalidate.length };
  }
}
```

**Unit test mock strategy:**

```typescript
let balanceRepo: { findOneBy: jest.Mock; save: jest.Mock };
let requestRepo: { find: jest.Mock; save: jest.Mock };
let syncLogService: { append: jest.Mock };
let dataSource: { transaction: jest.Mock };
let service: HcmSyncService;

beforeEach(() => {
  balanceRepo   = { findOneBy: jest.fn(), save: jest.fn() };
  requestRepo   = { find: jest.fn(), save: jest.fn() };
  syncLogService = { append: jest.fn() };
  dataSource    = { transaction: jest.fn() };
  service = new HcmSyncService(
    balanceRepo as any,
    requestRepo as any,
    syncLogService as any,
    dataSource as any,
  );
});
```

**Unit test cases:**

| ID | Scenario | Mock setup | Expected |
|----|----------|------------|----------|
| U-S-01 | Existing balance updated; available changes | `findOneBy → { available: 10, version: 2, ... }`, `find → []` | `save` called with `version: 3`; `syncLogService.append` called with `source: REALTIME_WEBHOOK, previousAvailable: 10, newAvailable: 8`; returns `{ updated: 1, invalidated: 0 }` |
| U-S-02 | Balance not found — creates new row | `findOneBy → null`, `find → []` | `save` called with `version: 1`; `syncLogService.append` called (previousAvailable=0, newAvailable=10); returns `{ updated: 1, invalidated: 0 }` |
| U-S-03 | Available unchanged — no sync_log row | `findOneBy → { available: 10, version: 1 }`, `find → []`, dto.available=10 | `save` called (version bumped); `syncLogService.append` NOT called; returns `{ updated: 1, invalidated: 0 }` |
| U-S-04 | PENDING request with days > new balance → invalidated | `findOneBy → { available: 10 }`, `find → [{ id: 'R-1', days: 8, status: PENDING }, { id: 'R-2', days: 3, status: APPROVED }]`, dto.available=5 | `requestRepo.save` called once (R-1 only) with `status: INVALIDATED`; `syncLogService.append` called with `source: INVALIDATION, requestId: 'R-1'`; returns `{ updated: 1, invalidated: 1 }` |
| U-S-05 | REJECTED / CANCELLED requests ignored | `find → [{ days: 8, status: REJECTED }, { days: 8, status: CANCELLED }]`, dto.available=5 | `requestRepo.save` NOT called; returns `{ updated: 1, invalidated: 0 }` |

Note: U-S-05 tests the query — the service calls `requestRepo.find()` with `where` clauses for `PENDING` and `APPROVED` only, so REJECTED/CANCELLED should never appear in the result. This test verifies the filter handles unexpected extras defensively.

**Done when:**
- [ ] `src/hcm-sync/hcm-sync.service.ts` created with `HcmSyncService` + `handleRealtimeUpdate()`
- [ ] `handleRealtimeUpdate` upserts balance with `version + 1` and `lastSyncedAt: new Date()`
- [ ] Sync log written only when `previousAvailable !== dto.available`
- [ ] New balance (no existing row) treated as `previousAvailable = 0`
- [ ] Invalidation: only PENDING/APPROVED requests where `days > dto.available` affected
- [ ] Invalidation sync_log has `source: INVALIDATION, requestId: req.id, actor: 'hcm-sync'`
- [ ] All 5 unit tests U-S-01..U-S-05 confirmed FAILING before implementation (RED)
- [ ] All 5 unit tests pass (GREEN)
- [ ] Gate check passes: `npm run test -- --testPathPattern=hcm-sync.service.spec`
- [ ] Test count: **5 tests pass** (unit test file only; not counting earlier tests)
- [ ] `npm run build` exits 0

**Tests:** unit (U-S-01..U-S-05)
**Gate:** `npm run test -- --testPathPattern=hcm-sync.service.spec`

**Commit:** `feat(hcm-sync): implement HcmSyncService.handleRealtimeUpdate with balance upsert and request invalidation`

---

### T5: Add `handleBatchSync()` + unit tests U-S-06..U-S-08

**What:** Add the batch ingest handler to `HcmSyncService`. All upserts and sync_log writes inside a single TypeORM transaction; one reconciliation JOIN query invalidates requests across all employees after the batch completes.

**Where:**
- `src/hcm-sync/hcm-sync.service.ts` — modify (add method)
- `test/unit/hcm-sync.service.spec.ts` — modify (add test cases)

**Depends on:** T4

**Implementation spec:**

```typescript
export interface BatchRecord {
  employeeId: string;
  locationId: string;
  available: number;
  used: number;
  total: number;
}

export interface BatchSyncDto {
  records: BatchRecord[];
}

export interface BatchSyncResult {
  updated: number;
  invalidated: number;
  errors: string[];
}

async handleBatchSync(dto: BatchSyncDto): Promise<BatchSyncResult> {
  let updated = 0;
  let invalidated = 0;

  await this.dataSource.transaction(async (manager) => {
    const balanceRepo = manager.getRepository(Balance);
    const requestRepo = manager.getRepository(TimeOffRequest);

    for (const record of dto.records) {
      const existing = await balanceRepo.findOneBy({
        employeeId: record.employeeId,
        locationId: record.locationId,
      });
      const previousAvailable = existing?.available ?? 0;

      await balanceRepo.save({
        ...record,
        version: (existing?.version ?? 0) + 1,
        lastSyncedAt: new Date(),
      });
      updated++;

      if (previousAvailable !== record.available) {
        await manager.save(SyncLog, {
          employeeId: record.employeeId,
          locationId: record.locationId,
          source: SyncSource.BATCH,
          previousAvailable,
          newAvailable: record.available,
          actor: 'hcm-batch',
          requestId: null,
        });
      }
    }

    // Reconciliation: JOIN across all employees
    const toInvalidate = await requestRepo
      .createQueryBuilder('r')
      .innerJoin(Balance, 'b', 'b.employee_id = r.employee_id AND b.location_id = r.location_id')
      .where('r.status IN (:...statuses)', { statuses: [RequestStatus.PENDING, RequestStatus.APPROVED] })
      .andWhere('r.days > b.available')
      .getMany();

    for (const req of toInvalidate) {
      const balance = await balanceRepo.findOneBy({ employeeId: req.employeeId, locationId: req.locationId });
      req.status = RequestStatus.INVALIDATED;
      await requestRepo.save(req);
      await manager.save(SyncLog, {
        employeeId: req.employeeId,
        locationId: req.locationId,
        source: SyncSource.INVALIDATION,
        previousAvailable: balance?.available ?? 0,
        newAvailable: balance?.available ?? 0,
        actor: 'hcm-sync',
        requestId: req.id,
      });
      invalidated++;
    }
  });

  return { updated, invalidated, errors: [] };
}
```

**Key implementation note on SyncLog inside transaction:** `manager.save(SyncLog, {...})` is used directly because `syncLogService.append()` holds its own `Repository` outside the transaction scope. The entity-manager path keeps all writes atomic.

**Unit test mock strategy (manager mock):**

```typescript
it('U-S-06: ...', async () => {
  const fakeManager = {
    getRepository: jest.fn().mockImplementation((entity) => {
      if (entity === Balance) return fakeBalanceRepo;
      if (entity === TimeOffRequest) return fakeRequestRepo;
    }),
    save: jest.fn(),
  };
  dataSource.transaction.mockImplementation((cb) => cb(fakeManager));
  // ...
});
```

**Unit test cases:**

| ID | Scenario | Mock setup | Expected |
|----|----------|------------|----------|
| U-S-06 | Batch with 2 records, no existing balances | `balanceRepo.findOneBy → null` for both, no PENDING/APPROVED requests | `balanceRepo.save` called twice; returns `{ updated: 2, invalidated: 0, errors: [] }` |
| U-S-07 | Idempotent: available unchanged → no sync_log row | `balanceRepo.findOneBy → { available: 10 }`, batch record `available: 10`, no PENDING/APPROVED | `balanceRepo.save` called; `manager.save(SyncLog, ...)` NOT called for that record |
| U-S-08 | Reconciliation: PENDING with days > new balance → invalidated | batch updates available=5, reconciliation query returns PENDING request with days=8 | returned request saved as INVALIDATED; INVALIDATION sync_log written; returns `{ updated: 1, invalidated: 1, errors: [] }` |

**Done when:**
- [ ] `handleBatchSync()` added to `HcmSyncService`
- [ ] All upserts run inside `dataSource.transaction()` callback
- [ ] `SyncLog` written via `manager.save(SyncLog, ...)` inside transaction (NOT via `syncLogService.append()`)
- [ ] Sync_log skipped when `previousAvailable === record.available`
- [ ] Reconciliation JOIN query runs after all records are upserted
- [ ] Invalidated requests get `status: INVALIDATED` and an INVALIDATION sync_log row per request
- [ ] All 8 unit tests U-S-01..U-S-08 pass (3 new + 5 from T4)
- [ ] Gate check: `npm run test -- --testPathPattern=hcm-sync.service.spec` exits 0, **8 tests pass**
- [ ] `npm run build` exits 0

**Tests:** unit (U-S-06..U-S-08)
**Gate:** `npm run test -- --testPathPattern=hcm-sync.service.spec`

**Commit:** `feat(hcm-sync): add HcmSyncService.handleBatchSync with transactional upsert and reconciliation`

---

### T6: `HcmSyncModule` wiring + integration tests I-04, I-05

**What:** Update `HcmSyncModule` to provide and export `HcmSyncService`. Add two integration tests that exercise the idempotency guard (I-04) and reconciliation filter (I-05) against a real in-memory SQLite DB.

**Where:**
- `src/hcm-sync/hcm-sync.module.ts` — modify
- `test/integration/hcm-sync.integration.spec.ts` — new

**Depends on:** T5

**Module wiring:**

```typescript
@Module({
  imports: [
    TypeOrmModule.forFeature([Balance, TimeOffRequest]),
    SyncLogModule,
  ],
  providers: [
    { provide: HCM_ADAPTER_TOKEN, useClass: HcmAdapterService },
    HcmSyncService,
  ],
  exports: [HCM_ADAPTER_TOKEN, HcmSyncService],
})
export class HcmSyncModule {}
```

`SyncLogModule` exports `SyncLogService`, which `HcmSyncService` injects. `TypeOrmModule.forFeature([Balance, TimeOffRequest])` provides the repositories. `ConfigModule` is already global in `AppModule`.

**Integration test setup (flat-provider pattern, mirrors `balances.integration.spec.ts`):**

```typescript
module = await Test.createTestingModule({
  imports: [
    TypeOrmModule.forRoot({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Balance, SyncLog, TimeOffRequest],
      synchronize: true,
    }),
    TypeOrmModule.forFeature([Balance, SyncLog, TimeOffRequest]),
  ],
  providers: [HcmSyncService, SyncLogService],
}).compile();
```

Note: `DataSource` is provided automatically by `TypeOrmModule.forRoot`.

**Integration test cases:**

| ID | Scenario | Setup | Expected |
|----|----------|-------|----------|
| I-04 | Batch idempotency — same payload twice writes only one sync_log row | Seed empty DB. Run `handleBatchSync` with `{ records: [{ employeeId: 'E-1', locationId: 'L-1', available: 8, used: 2, total: 10 }] }` twice | `balances` row: `available=8`, `version=2`; `sync_log` row count: **1** (second run didn't change available, skipped log) |
| I-05 | Reconciliation selects only PENDING/APPROVED where `days > available`; ignores REJECTED | Seed balance `{ E-1, L-1, available: 5 }`. Seed 3 requests: PENDING days=8 (should invalidate), APPROVED days=3 (stays), REJECTED days=12 (ignored). Run `handleBatchSync` with `available=5` (same, no change to trigger sync_log) — or run `handleBatchSync` with updated available=5 from available=10 | After batch: PENDING request → INVALIDATED; APPROVED request → APPROVED; REJECTED request → REJECTED; returns `{ invalidated: 1 }` |

> **I-05 seed note:** Seed the balance with `available=10` first, then run batch with `available=5`. This ensures the balance changes, the sync_log is written for the balance update, and the reconciliation correctly identifies PENDING days=8 > 5.

**Done when:**
- [ ] `HcmSyncModule` imports `[TypeOrmModule.forFeature([Balance, TimeOffRequest]), SyncLogModule]`
- [ ] `HcmSyncModule` providers: `[{ provide: HCM_ADAPTER_TOKEN, useClass: HcmAdapterService }, HcmSyncService]`
- [ ] `HcmSyncModule` exports: `[HCM_ADAPTER_TOKEN, HcmSyncService]`
- [ ] `npm run build` exits 0 with updated module
- [ ] Integration test file exists at `test/integration/hcm-sync.integration.spec.ts`
- [ ] I-04 passes: balance row at `available=8, version=2`; exactly **1** sync_log row
- [ ] I-05 passes: PENDING request has `status=INVALIDATED`; APPROVED and REJECTED unchanged
- [ ] Gate check: `npm run test -- --testPathPattern=hcm-sync.integration.spec` exits 0, **2 tests pass**
- [ ] All prior unit tests still pass: `npm run test -- --testPathPattern=hcm-sync.service.spec` exits 0

**Tests:** integration (I-04, I-05)
**Gate:** `npm run test -- --testPathPattern=hcm-sync.integration.spec`

**Commit:** `feat(hcm-sync): wire HcmSyncService in module and add integration tests for idempotency and reconciliation`

---

## Parallel Execution Map (F-05)

```
Phase 1 (Sequential — each task depends on the previous):
  T4 (HcmSyncService + handleRealtimeUpdate + unit tests U-S-01..U-S-05)
    └── T5 (handleBatchSync + unit tests U-S-06..U-S-08)
         └── T6 (HcmSyncModule wiring + integration tests I-04, I-05)
```

No parallel phases. All tasks are strictly sequential.

---

## Validation Report (F-05)

### Check 1: Task Granularity

| Task | Scope | Status |
|------|-------|--------|
| T4: HcmSyncService + handleRealtimeUpdate + unit tests | 1 service file + 1 test file; 1 method | ✅ Granular |
| T5: handleBatchSync + unit tests | Modify 2 files; 1 method added | ✅ Granular |
| T6: HcmSyncModule wiring + integration tests | 1 module file (5 lines changed) + 1 new test file | ✅ Granular |

### Check 2: Diagram-Definition Cross-Check

| Task | Depends On (body) | Diagram Shows | Status |
|------|-------------------|---------------|--------|
| T4 | F-04 complete (T3) | Start of F-05 chain | ✅ Match |
| T5 | T4 | T4 → T5 | ✅ Match |
| T6 | T5 | T5 → T6 | ✅ Match |

No tasks are marked `[P]`; no parallel dependency conflicts possible. ✅

### Check 3: Test Co-location Validation

| Task | Code Layer Created/Modified | TEST_STRATEGY Requires | Task Says | Status |
|------|-----------------------------|-----------------------|-----------|--------|
| T4: HcmSyncService + handleRealtimeUpdate | Service (business logic) | Unit | Unit (U-S-01..U-S-05) | ✅ Match |
| T5: handleBatchSync | Service (business logic, transaction) | Unit | Unit (U-S-06..U-S-08) | ✅ Match |
| T6: HcmSyncModule wiring | Module + DB interaction | Integration | Integration (I-04, I-05) | ✅ Match |

No deferred tests. All service-layer code has co-located unit tests. Integration tests cover the two spec-required integration scenarios (idempotency and reconciliation filter scope). ✅
