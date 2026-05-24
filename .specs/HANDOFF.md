# Handoff

**Date:** 2026-05-24T00:00:00Z
**Feature:** F-06 — Resilience: circuit breaker + retry + health check + graceful shutdown
**Task:** All 3 tasks complete — F-06 fully delivered ✅

---

## Completed ✓

- **F-04 — all 3 tasks (prior session):**
  - T1: `HcmAdapterService` + 9 unit tests U-A-01..U-A-09
  - T2: `HcmSyncModule` provides `HCM_ADAPTER_TOKEN → HcmAdapterService`
  - T3: `TimeOffRequestsModule` imports `HcmSyncModule`

- **F-05 — all 3 tasks (prior session):**
  - T4: `HcmSyncService.handleRealtimeUpdate()` — upserts balance, writes REALTIME_WEBHOOK sync_log, invalidates PENDING/APPROVED requests
  - T5: `HcmSyncService.handleBatchSync()` — full `dataSource.transaction()`, reconciliation
  - T6: `HcmSyncModule` updated; integration tests I-04 + I-05

- **F-06 — all 3 tasks (this session):**
  - T1: Circuit breaker in `HcmAdapterService` (`src/hcm-sync/adapters/hcm-adapter.service.ts`) — three `opossum` `CircuitBreaker` instances (`deductBreaker`, `restoreBreaker`, `pingBreaker`), config from `ConfigService`, fallback throws `HcmUnavailableException`. Tests U-A-10, U-A-11, U-A-12.
  - T2: Retry + dead-letter on `restore()` — `FAILED_RETRY` added to `SyncSource` enum; `executeRestore` retries 3×(1s/2s/4s); on exhaustion writes `sync_log` with `source: FAILED_RETRY` + logs `MANUAL_RECONCILIATION_REQUIRED`; `SyncLogService` injected. Tests U-A-13 (R-03), U-A-14 (R-04).
  - T3: `HealthController` + `HealthModule` — `GET /v1/health` via `@nestjs/terminus`; custom `HcmHealthIndicator` (axios, no `@nestjs/axios`); `ok`/`degraded`/`down` states; integration tests R-05, R-06, R-07.

- **Test counts:** 50 total (34 unit + 11 integration + 5 new) — all pass
- **`npm run build`** exits 0
- **Branch:** `feat/Tasks-06`

### Key implementation details

- `HcmAdapterService` now injects `SyncLogService` (available via `HcmSyncModule` → `SyncLogModule`, no module changes needed)
- `CircuitBreaker.isOurError()` distinguishes circuit-open rejections from domain exceptions in fallback handlers — `HcmRejectionException`/`InsufficientBalanceException` propagate correctly
- `executeRestore` retry uses `sleep()` helper (setTimeout-based); tests use `jest.useFakeTimers()` + `jest.runAllTimersAsync()`; rejection handler attached BEFORE advancing timers to avoid `PromiseRejectionHandledWarning`
- `HcmHealthIndicator` is a custom `HealthIndicator` subclass using `axios` directly; `HCM_BASE_URL` injected via `HCM_BASE_URL_TOKEN` for testability
- `HealthController` catches `ServiceUnavailableException` from terminus; if only `hcm` failed → HTTP 200 `{ status: 'degraded' }`; if `db` failed → rethrows → HTTP 503

---

## In Progress

Nothing — session ended cleanly after F-06 completion.

---

## Pending

1. **F-07 — API layer: controllers + DTOs + global filter + trace interceptor**
   - `TimeOffRequestsController` (submit/approve/reject/cancel/list/get)
   - `BalancesController` (GET balance)
   - `HcmSyncController` (POST realtime, POST batch)
   - Global exception filter (`AllExceptionsFilter`) in `CommonModule`
   - Trace interceptor (`TraceInterceptor`) assigning UUID traceId per request
   - Use `/implement-api` command

2. **F-08 — Mock HCM server**
3. **F-09 — Full test suite**

---

## Blockers

- **B-001** — HCM API field names unconfirmed. Workaround: using mock-hcm assumed paths.
- **B-002** — HCM idempotency key not confirmed. Deduct retry disabled per AD-009.

---

## Context

- F-06 is the last infrastructure/resilience layer; all core business logic and resilience patterns are now implemented
- No controllers yet (F-07); services are only callable internally
- Circuit breaker state is in-memory (resets on process restart) — acceptable for Phase 1
- Related decisions: AD-007 (circuit breaker), AD-009 (idempotency key, retry on restore only)
- Milestone M4 entry gate: F-07 complete (`/health` returns ok; all E2E tests pass after F-08 + F-09)
