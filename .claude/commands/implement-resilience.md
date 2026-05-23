# /implement-resilience

Implement all resilience mechanisms for the ExampleHR Time-Off Microservice.

## Scope

You are implementing:
- **Circuit breaker** wrapping `HcmAdapterService` using `opossum`
- **Retry with exponential backoff** for idempotent HCM calls (restore only)
- **`X-Idempotency-Key`** header on all outbound HCM calls
- **Health check endpoint** (`GET /health`) via `@nestjs/terminus`
- **Graceful shutdown** handler in `main.ts`
- **Dead letter logging** in `sync_log` after retry exhaustion

Assume `HcmAdapterService` already exists with `deduct()`, `restore()`, and `ping()` methods. You are wrapping those methods — not re-implementing them.

## Documents to read before writing any code

- @docs/RESILIENCE.md — full spec: circuit breaker states and config, retry schedule, idempotency key format, graceful shutdown sequence, health check shape, dead letter handling
- @docs/ARCHITECTURE.md — circuit breaker state diagram (section 7), health check in component diagram
- @docs/ERROR_HANDLING.md — HcmUnavailableException, structured logging, MANUAL_RECONCILIATION_REQUIRED log format
- @docs/CLEAN_CODE.md — ConfigService usage for all env vars, no process.env in services

## Key implementation rules

1. **Circuit breaker** is a class-level singleton on `HcmAdapterService` — one `CircuitBreaker` instance per method type, not per call.
2. **Config from env** (via `ConfigService`): `CIRCUIT_BREAKER_THRESHOLD` (default 0.5), `CIRCUIT_BREAKER_VOLUME` (default 10), `CIRCUIT_BREAKER_RESET_TIMEOUT_MS` (default 30000).
3. **On OPEN state**: throw `HcmUnavailableException` immediately — zero network call, zero wait.
4. **Retry applies only to `restore()`**: 3 attempts, 1s/2s/4s backoff. After exhaustion: write `sync_log` entry (`source = 'failed_retry'`), log `WARN` with `MANUAL_RECONCILIATION_REQUIRED` and `traceId`, then throw `HcmUnavailableException`.
5. **No retry on `deduct()`**: a second call could double-deduct. Do not add retry here until TRD Open Question #4 (idempotency key confirmation) is resolved.
6. **`X-Idempotency-Key`** format: `${requestId}-${operation}` (e.g., `req-uuid-cancel`). Send on every outbound HCM call.
7. **Health check** (`GET /health`): TypeORM DB check + HCM ping (3s timeout). Response: `ok` / `degraded` (HCM down) / `down` (DB down). HTTP 200 for ok/degraded, 503 for down.
8. **Graceful shutdown**: `enableShutdownHooks()` in `main.ts`. On SIGTERM: stop accepting connections, 30s drain, `DataSource.destroy()`, exit 0.

## Do NOT load

- `docs/API_SPEC.md` — health endpoint shape is fully specified in RESILIENCE.md
- `docs/USE_CASES.md` — not relevant to infrastructure concerns
- `docs/DATA_MODEL.md` — only the sync_log write matters; entity already exists
- `docs/PREMISES.md` and `docs/SCOPE.md` — not needed for implementation
