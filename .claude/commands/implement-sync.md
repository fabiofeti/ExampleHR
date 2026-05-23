# /implement-sync

Implement the HCM synchronization module for the ExampleHR Time-Off Microservice.

## Scope

You are implementing the **`hcm-sync/`** module:
- `IHcmAdapter` interface in `src/hcm-sync/ports/hcm-adapter.port.ts`
- `HcmAdapterService` — production HTTP client implementing `IHcmAdapter`, wrapped with circuit breaker and retry
- `HcmSyncService` — handles inbound real-time webhook and batch upsert, runs reconciliation
- `SyncLog` entity and `SyncLogService`

Assume `BalancesService` and `TimeOffRequestsService` already exist (implemented in `/implement-core`). You will call their methods — do not re-implement them.

## Documents to read before writing any code

- @docs/TRD.md — especially C1–C5 solutions and C6–C7 additions (HCM downtime, partial write window)
- @docs/ARCHITECTURE.md — sync flow sequence diagrams (sections 4 and 5), circuit breaker diagram
- @docs/RESILIENCE.md — full circuit breaker config, retry strategy, idempotency key format, dead letter handling
- @docs/CLEAN_CODE.md — IHcmAdapter interface pattern, module layering, exception rules
- @docs/ERROR_HANDLING.md — HcmRejectionException, HcmUnavailableException, structured logging

## Key implementation rules

1. **`IHcmAdapter`** must define exactly: `deduct(...)`, `restore(...)`, `ping()` — nothing else.
2. **`HcmAdapterService`** wraps each method in an `opossum` circuit breaker instance. The circuit is a class-level singleton, not created per-call.
3. **Retry** applies only to `restore()` — 3 attempts with 1s/2s/4s backoff. No retry on `deduct()`.
4. **Idempotency key** header `X-Idempotency-Key: {requestId}-{operation}` on every HCM call.
5. **`HcmSyncService.handleRealtimeUpdate(dto)`** — upsert balance (increment version), write sync_log, run invalidation check for PENDING requests.
6. **`HcmSyncService.handleBatchSync(dto)`** — process all records in a TypeORM transaction, upsert each balance, write sync_log for each, then run reconciliation across all PENDING and APPROVED requests.
7. **Reconciliation query**: `SELECT r.* FROM time_off_requests r JOIN balances b ON ... WHERE r.status IN ('PENDING','APPROVED') AND r.days > b.available` — transition matched to `INVALIDATED`.
8. **Dead letter**: after retry exhaustion, write sync_log entry with `source = 'failed_retry'`, log WARN with `MANUAL_RECONCILIATION_REQUIRED`.
9. Circuit breaker config from `ConfigService`: `CIRCUIT_BREAKER_THRESHOLD`, `CIRCUIT_BREAKER_VOLUME`, `CIRCUIT_BREAKER_RESET_TIMEOUT_MS`.

## Do NOT load

- `docs/API_SPEC.md` — controllers are in /implement-api
- `docs/DATA_MODEL.md` — entities already exist from /implement-core
- `docs/USE_CASES.md` — all behavior defined in TRD + ARCHITECTURE diagrams
- `docs/TEST_STRATEGY.md` — tests are a separate session
- `docs/SCOPE.md` and `docs/PREMISES.md` — foundational context not needed for implementation
