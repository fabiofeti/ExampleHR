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

## Validation Report

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
