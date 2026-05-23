# Resilience Patterns

This document defines the resilience strategy for all HCM integration points, service availability, and recovery from partial failures. Every pattern here must be implemented — they are not optional enhancements.

---

## 1. Circuit Breaker

**Library:** `opossum`  
**Scope:** Wraps every outbound call in `HcmAdapterService` (deduct, restore, ping).

### States

```
CLOSED ──(error rate ≥ 50% over 10 calls)──► OPEN
  ▲                                              │
  │                                         (after 30s)
  │                                              ▼
  └──(probe succeeds)──────────────────── HALF_OPEN
```

| State | Behavior |
|-------|---------|
| `CLOSED` | Normal operation; all calls pass through to HCM. |
| `OPEN` | Fail fast — throw `HcmUnavailableException` immediately, no network call. |
| `HALF_OPEN` | Allow exactly 1 probe call. Success → `CLOSED`. Failure → `OPEN` again. |

### Configuration (env vars)

| Var | Default | Description |
|-----|---------|-------------|
| `CIRCUIT_BREAKER_THRESHOLD` | `0.5` | Error rate threshold (50%) to open circuit. |
| `CIRCUIT_BREAKER_VOLUME` | `10` | Minimum call volume before threshold applies. |
| `CIRCUIT_BREAKER_RESET_TIMEOUT_MS` | `30000` | Time (ms) circuit stays `OPEN` before probing. |

### Behavior during OPEN state

- Read endpoints (`GET /balances`, `GET /time-off-requests`) continue to work (no HCM calls needed).
- Write endpoints (`approve`, `cancel`) immediately return `503 HCM_UNAVAILABLE`.
- Health endpoint returns `{ status: 'degraded' }`.

---

## 2. Retry Strategy

**Library:** Built-in with exponential backoff (no additional dependency needed).

### Rule: Retry only idempotent operations

| Operation | Retryable | Reason |
|-----------|-----------|--------|
| HCM restore (cancel) | **Yes** | Same call can be repeated safely; idempotency key is sent. |
| Realtime webhook acknowledgment | **Yes** | Idempotent; HCM expects at-least-once delivery. |
| HCM deduct (approve) | **No** | Non-idempotent until TRD Open Question #4 is resolved. A retry could cause a double deduction. |
| Batch sync acknowledgment | **No** | One response per batch; no partial retry needed. |

### Retry schedule

```
Attempt 1: immediate failure
Attempt 2: wait 1s, retry
Attempt 3: wait 2s, retry
Attempt 4: wait 4s, retry
→ give up; enter dead letter handling
```

Max total wait time: 7s (plus HCM timeout per attempt).

### Idempotency key format

All HCM outbound calls must include:
```
X-Idempotency-Key: {requestId}-{operation}
```
Examples:
- `X-Idempotency-Key: req-uuid-1234-cancel`
- `X-Idempotency-Key: req-uuid-1234-approve`

When HCM confirms idempotency key support (Open Question #4 in TRD), enable retry for the deduct operation as well.

---

## 3. Timeout

All outbound HCM calls use:

| Call type | Timeout |
|-----------|---------|
| Real-time deduct / restore / ping | `HCM_TIMEOUT_MS` (default `5000` ms) |
| Batch ingest processing | `30000` ms |

Timeout is enforced by the HTTP client (`axios` with `timeout` config). On timeout expiry, throw `HcmUnavailableException`.

---

## 4. Graceful Shutdown

**NestJS hook:** `enableShutdownHooks()` in `main.ts`.

### Shutdown sequence on SIGTERM / SIGINT

```
1. Fastify/Express stops accepting new connections
2. NestJS runs OnModuleDestroy hooks (30s grace window)
3. In-flight requests continue to completion or their own timeout
4. TypeORM DataSource.destroy() closes SQLite connection cleanly
5. Process exits with code 0
```

If in-flight requests do not complete within 30s, the process force-exits.

**Key:** HCM calls that are mid-flight during shutdown are allowed to complete (they have their own `HCM_TIMEOUT_MS` limit). Do not abort them on SIGTERM.

---

## 5. Health Check Endpoint

**Route:** `GET /health`  
**Library:** `@nestjs/terminus`  
**Auth:** None (public; monitored by load balancer / k8s liveness probe).

### Checks

| Check | Indicator | Method |
|-------|-----------|--------|
| `db` | `TypeOrmHealthIndicator` | `.pingCheck('db')` — executes `SELECT 1` |
| `hcm` | `HttpHealthIndicator` | `.pingCheck('hcm', HCM_BASE_URL/health)` — 3s timeout |

### Response shape

```json
{
  "status": "ok",
  "info": {
    "db":  { "status": "up" },
    "hcm": { "status": "up" }
  }
}
```

### Status mapping

| DB | HCM | Overall status | HTTP code |
|----|-----|----------------|-----------|
| up | up | `ok` | 200 |
| up | down | `degraded` | 200 |
| down | any | `down` | 503 |

`degraded` means reads work but writes will return 503. Alerting systems should page on `down` and notify on `degraded`.

---

## 6. Dead Letter Handling

When all retry attempts for an idempotent HCM call are exhausted:

1. Write to `sync_log` with `source = 'failed_retry'`, including `traceId` and the failed operation.
2. Log at `WARN` level with message `MANUAL_RECONCILIATION_REQUIRED`.
3. Return `503 HCM_UNAVAILABLE` to the caller with the `traceId` for support correlation.
4. The balance and request status remain **unchanged** — no partial state mutation.

**Phase 2:** Route dead-letter events to a monitoring integration (PagerDuty, Slack webhook) and trigger automated reconciliation against HCM batch endpoint.

---

## 7. New Challenges Addressed (TRD supplement)

### C6 — HCM Downtime

**Problem:** HCM may be down for minutes or hours. Without a circuit breaker, every request blocks for 5s before failing. Under load this exhausts the thread pool.

**Solution:** Circuit breaker opens after the first sustained outage. Subsequent write requests fail fast (< 1ms). Reads remain available. Circuit auto-recovers when HCM comes back. No operator intervention needed.

### C7 — Partial Write Window

**Problem:** HCM deduction succeeds (step 2 of approval) but the local DB commit fails (crash, deadlock, DB unavailability at step 3). HCM balance is now lower than ExampleHR's cache reflects.

**Solution:** The `sync_log` provides the recovery path:
- The next HCM inbound sync (realtime webhook or batch) pushes the authoritative balance.
- Reconciliation detects the delta mismatch.
- The `sync_log` records `previous_available` vs. `new_available` — the unexplained gap is visible.
- Alert on gap between `sync_log` expected delta and actual delta triggers manual review if needed.

This window is narrow (sub-second) and self-healing on next sync. It is acceptable given the eventual-consistency premise for balance reads (Premise 8).
