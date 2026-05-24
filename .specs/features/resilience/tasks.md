# F-06 Resilience Tasks

**Spec**: `docs/RESILIENCE.md`
**Status**: Done

---

## Context

Both `opossum` and `@nestjs/terminus` are already in `package.json`.  
`enableShutdownHooks()` is already wired in `main.ts` — graceful shutdown is done.  
`HealthModule` is a stub in `AppModule` — needs implementation only.  
`SyncLogModule` (exports `SyncLogService`) is already imported by `HcmSyncModule` — no module wiring changes needed for T2.

Baseline test counts before F-06: **34 unit + 8 integration = 42 total**.

---

## Execution Plan

### Phase 1 — Parallel

T1 and T3 have no mutual dependency and can run simultaneously.

```
T1 [circuit breaker + unit tests]  ──┐
                                      ├──→ T2 [retry + dead-letter + unit tests]
T3 [health endpoint + integration]  ──┘ (T3 has no dep on T2 but must finish before overall gate)
```

### Phase 2 — Sequential

```
T1 complete → T2
```

---

## Task Breakdown

### T1: Circuit breaker in HcmAdapterService + unit tests

**What**: Add three `opossum` `CircuitBreaker` instances (one per outbound method) to `HcmAdapterService`; all config from `ConfigService`; fallback throws `HcmUnavailableException`.
**Where**: `src/hcm-sync/adapters/hcm-adapter.service.ts`
**Depends on**: None
**Reuses**: Existing `ConfigService` injection; `HcmUnavailableException`; opossum `CircuitBreaker` / `@types/opossum`
**Requirement**: RESILIENCE.md §1 (circuit breaker), AD-007

**Implementation notes**:
- Create three class-level breaker instances in the constructor: `deductBreaker`, `restoreBreaker`, `pingBreaker`
- opossum options (same for all three):
  ```ts
  {
    errorThresholdPercentage: config.get<number>('CIRCUIT_BREAKER_THRESHOLD') * 100,
    volumeThreshold: config.get<number>('CIRCUIT_BREAKER_VOLUME'),
    resetTimeout: config.get<number>('CIRCUIT_BREAKER_RESET_TIMEOUT_MS'),
    timeout: false, // axios already handles timeouts
  }
  ```
- Each breaker's fallback: `breaker.fallback(() => { throw new HcmUnavailableException('circuit-open'); })`
- `deduct()` → `this.deductBreaker.fire(employeeId, locationId, days, idempotencyKey)` where the action calls axios
- `restore()` → `this.restoreBreaker.fire(...)` (retry logic added in T2; action is the plain HTTP call for now)
- `ping()` → `this.pingBreaker.fire()` where action calls `GET /health`; fallback returns `false` (not throw)
- Preserve all existing error mapping (`mapDeductError`) inside the breaker action functions
- opossum's `CircuitBreaker` is not an NestJS-injectable — instantiate directly with `new CircuitBreaker(action, options)`

**Done when**:
- [ ] Three breaker instances created in constructor, configured from `ConfigService`
- [ ] `deduct()`, `restore()`, `ping()` route through their respective breakers
- [ ] When breaker is OPEN, `deduct()` and `restore()` throw `HcmUnavailableException` immediately (no HTTP call)
- [ ] When breaker is OPEN, `ping()` returns `false` (no throw)
- [ ] Existing 9 unit tests in `hcm-adapter.service.spec.ts` still pass (U-A-01..U-A-09)
- [ ] New unit tests: circuit OPEN for `deduct()` (no HTTP, throws), circuit OPEN for `restore()` (no HTTP, throws), circuit OPEN for `ping()` (no HTTP, returns false), circuit closes after successful probe (~3 new tests)
- [ ] Gate check passes: `npm run test -- --testPathPattern=hcm-adapter.service`
- [ ] Test count: ≥ 12 tests pass in `hcm-adapter.service.spec.ts` (9 existing + ≥3 new)
- [ ] `npm run build` exits 0

**Tests**: unit
**Gate**: quick → `npm run test -- --testPathPattern=hcm-adapter.service`

**Commit**: `feat(hcm-adapter): wrap deduct/restore/ping with opossum circuit breaker`

---

### T2: Retry + dead-letter on restore() + FAILED_RETRY enum + unit tests

**What**: Add exponential-backoff retry (3 attempts: 1s/2s/4s delays) inside `restoreBreaker`'s action; on exhaustion write a `FAILED_RETRY` sync_log entry and throw `HcmUnavailableException`. Also add the `FAILED_RETRY` value to `SyncSource` enum.
**Where**:
  - `src/sync-log/sync-log.entity.ts` — add `FAILED_RETRY = 'failed_retry'` to `SyncSource`
  - `src/hcm-sync/adapters/hcm-adapter.service.ts` — inject `SyncLogService`, add retry logic inside restoreBreaker action
**Depends on**: T1
**Reuses**: `SyncLogService.append()` (already exported by `SyncLogModule`); existing `HcmUnavailableException`; `SyncSource` enum
**Requirement**: RESILIENCE.md §2 (retry), §6 (dead letter), AD-009, TEST_STRATEGY R-03, R-04

**Implementation notes**:

Retry schedule (3 retries after initial attempt = 4 total HTTP calls max):
```
Attempt 1 → fail → wait 1000ms
Attempt 2 → fail → wait 2000ms
Attempt 3 → fail → wait 4000ms
Attempt 4 → fail → dead letter
```

The retry logic lives INSIDE `restoreBreaker`'s action function (not outside the breaker call). This means the circuit breaker records a single failure only after all retries are exhausted — one restore operation = one circuit breaker event.

Dead-letter sync_log entry fields:
- `source`: `SyncSource.FAILED_RETRY`
- `employeeId`, `locationId`: from `restore()` params
- `previousAvailable`: `0` (no balance change occurred)
- `newAvailable`: `0`
- `requestId`: extracted from `idempotencyKey` (format `{requestId}-cancel` → split on `-cancel` and take prefix)
- `actor`: `'hcm-adapter-retry'`

After writing sync_log: log WARN `'MANUAL_RECONCILIATION_REQUIRED'` with `{ traceId: idempotencyKey }`, then throw `HcmUnavailableException(idempotencyKey)`.

Inject `SyncLogService` in the constructor (already provided via `HcmSyncModule`'s import of `SyncLogModule`). No module changes needed.

**Done when**:
- [ ] `FAILED_RETRY = 'failed_retry'` added to `SyncSource` enum
- [ ] `SyncLogService` injected into `HcmAdapterService` constructor
- [ ] `restoreBreaker`'s action function retries up to 3 times with 1s/2s/4s delays on failure
- [ ] On all retries exhausted: sync_log FAILED_RETRY entry written, WARN logged, `HcmUnavailableException` thrown
- [ ] Balance and request state remain UNCHANGED (dead-letter does not mutate DB)
- [ ] R-03 unit test: mock HTTP succeeds on attempt 2 → operation resolves, no dead-letter entry
- [ ] R-04 unit test: mock HTTP always fails → `SyncLogService.append` called once with `source: FAILED_RETRY`, throws `HcmUnavailableException`
- [ ] All previous tests still pass (≥12 from T1 gate)
- [ ] Gate check passes: `npm run test -- --testPathPattern=hcm-adapter.service`
- [ ] Test count: ≥ 18 tests pass in `hcm-adapter.service.spec.ts`
- [ ] `npm run build` exits 0

**Tests**: unit
**Gate**: quick → `npm run test -- --testPathPattern=hcm-adapter.service`

**Commit**: `feat(hcm-adapter): retry restore() with exponential backoff and dead-letter to sync_log`

---

### T3: HealthController + HealthModule wiring + integration tests [P]

**What**: Implement `GET /health` using `@nestjs/terminus` with DB + HCM checks; custom logic returns `{ status: 'degraded' }` HTTP 200 when HCM is down but DB is up; wire `HealthModule` with all required imports and providers.
**Where**:
  - `src/health/health.controller.ts` — create `HealthController`
  - `src/health/health.module.ts` — wire `TerminusModule`, `HttpModule`, `HealthController`
  - `test/integration/health.integration.spec.ts` — integration tests R-05, R-06, R-07
**Depends on**: None
**Reuses**: `@nestjs/terminus` (`HealthCheckService`, `TypeOrmHealthIndicator`, `HttpHealthIndicator`); `ConfigService` (for `HCM_BASE_URL`); `HealthModule` stub already in `AppModule`
**Requirement**: RESILIENCE.md §5 (health check), TEST_STRATEGY R-05..R-07

**Implementation notes**:

Route: `GET /health` (NestJS global prefix is `v1`, so full path is `GET /v1/health`).

Response shapes:
```
DB up + HCM up:   HTTP 200  { status: 'ok',       info: { db: {status:'up'}, hcm: {status:'up'} } }
DB up + HCM down: HTTP 200  { status: 'degraded',  info: { db: {status:'up'} }, error: { hcm: {status:'down'} } }
DB down + any:    HTTP 503  { status: 'down' }
```

`HealthCheckService.check()` throws a `HealthCheckError` when any check fails. Catch it, inspect `.response.details` to distinguish which indicator failed:
- If only `hcm` failed → return a custom 200 response with `status: 'degraded'`
- If `db` failed → rethrow (terminus will return 503)

HCM health check: `this.http.pingCheck('hcm', \`${hcmBaseUrl}/health\`, { timeout: 3000 })`

`HealthModule` needs:
```ts
imports: [TerminusModule, HttpModule],
providers: [/* TypeOrmHealthIndicator and HttpHealthIndicator are provided by terminus */],
controllers: [HealthController],
```

Note: `TypeOrmHealthIndicator` requires `TypeOrmModule` to be available in context — it reads from the global TypeORM connection, which is provided globally via `AppModule`. No extra `TypeOrmModule.forFeature()` needed.

Integration test setup: use `Test.createTestingModule` with `AppModule` (or a minimal subset) and a real SQLite `:memory:` DB; override `HCM_BASE_URL` to point to a local test server or use `nock` to intercept HTTP calls.

For R-06 (HCM down): configure `HttpHealthIndicator` target to an unreachable URL or override the HTTP call to timeout.
For R-07 (DB down): manually call `DataSource.destroy()` then hit `/health` — expect HTTP 503.

**Done when**:
- [ ] `GET /v1/health` responds HTTP 200 `{ status: 'ok', ... }` when DB and HCM are both up
- [ ] `GET /v1/health` responds HTTP 200 `{ status: 'degraded', ... }` when HCM check fails but DB is up
- [ ] `GET /v1/health` responds HTTP 503 `{ status: 'down' }` when DB is down
- [ ] R-05 integration test passes (DB up + HCM up → 200 ok)
- [ ] R-06 integration test passes (HCM mock down → 200 degraded)
- [ ] R-07 integration test passes (DB closed → 503 down)
- [ ] Gate check passes: `npm run test -- --testPathPattern=health.integration`
- [ ] Test count: 3 new integration tests pass (total integration ≥ 11)
- [ ] `npm run build` exits 0

**Tests**: integration
**Gate**: quick → `npm run test -- --testPathPattern=health.integration`

**Commit**: `feat(health): implement GET /health with terminus DB + HCM indicators and degraded state`

---

## Parallel Execution Map

```
Phase 1 (Parallel):
  T1 [P] ──────────────────────→ Phase 2
  T3 [P] (independent) ────────→ done

Phase 2 (Sequential):
  T1 complete → T2
```

T3 can start at the same time as T1. T2 must wait for T1. Final full gate runs after all three complete.

**Full gate** (all tasks done): `npm run test`  
Expected: ≥ 53 tests pass (42 baseline + ~6 unit from T1+T2 + ~3 integration from T3 — exact count set in each Done When)

---

## Validation Tables

### Check 1: Granularity

| Task | Scope | Status |
|------|-------|--------|
| T1: Circuit breaker | 1 file (`hcm-adapter.service.ts`), 1 concern (breaker wiring) | ✅ Granular |
| T2: Retry + dead-letter | 2 files (`sync-log.entity.ts` enum + `hcm-adapter.service.ts` logic), cohesive retry feature | ✅ Granular |
| T3: Health endpoint | 2 files (controller + module), 1 feature (health check) | ✅ Granular |

### Check 2: Diagram-Definition Cross-Check

| Task | Depends On (task body) | Diagram Shows | Status |
|------|------------------------|---------------|--------|
| T1 | None | Phase 1 (no incoming arrows) | ✅ Match |
| T2 | T1 | T1 → T2 arrow | ✅ Match |
| T3 | None | Phase 1 parallel with T1 (no arrows to/from T1 or T2) | ✅ Match |

### Check 3: Test Co-location Validation

| Task | Code Layer Created/Modified | Matrix Requires | Task Says | Status |
|------|-----------------------------|-----------------|-----------|--------|
| T1 | HcmAdapterService (circuit breaker) | unit | unit | ✅ OK |
| T2 | HcmAdapterService (retry/dead-letter) + SyncSource enum | unit | unit | ✅ OK |
| T3 | HealthController + HealthModule | integration | integration | ✅ OK |

---

## Notes

- Graceful shutdown (`enableShutdownHooks()` in `main.ts`) is already complete — no task needed.
- R-08 (SIGTERM test) is an E2E test belonging to F-09, not F-06.
- B-001 and B-002 blockers do not affect F-06 — circuit breaker and retry logic work regardless of HCM API field names.
- After F-06, use `/implement-resilience` command which loads RESILIENCE.md, ARCHITECTURE.md, ERROR_HANDLING.md, CLEAN_CODE.md.
