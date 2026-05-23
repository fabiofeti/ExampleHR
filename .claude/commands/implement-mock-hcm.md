# /implement-mock-hcm

Implement the mock HCM server used as a test fixture for the ExampleHR Time-Off Microservice.

## Scope

You are implementing a standalone **Express server** in `test/mock-hcm/` that simulates the HCM real-time API. It is used exclusively in the test suite — never in production.

Files to create:
- `test/mock-hcm/server.ts` — Express app with all endpoints and behavior modes
- `test/mock-hcm/state.ts` — in-memory balance store and mode management
- `test/mock-hcm/index.ts` — start/stop helper for use in Jest `beforeAll`/`afterAll`

## Documents to read before writing any code

- @docs/TEST_STRATEGY.md — mock HCM server spec: all 5 behavior modes, all endpoints, how it is used in E2E tests
- @docs/API_SPEC.md — HCM sync endpoints (`POST /hcm/sync/realtime`, `POST /hcm/sync/batch`) — the mock must push to these when instructed
- @docs/RESILIENCE.md — timeout simulation: `timeout-next` mode must delay for longer than `HCM_TIMEOUT_MS` (default 5s); use 10s delay

## Endpoints the mock server must expose

### HCM Real-Time API (called by ExampleHR → HCM)
- `POST /hcm/deduct` — deduct days from balance; validate `X-Idempotency-Key` header is present; return updated balance or error
- `POST /hcm/restore` — restore days to balance; return updated balance
- `GET /hcm/balance/:employeeId/:locationId` — return current mock balance

### Test Control API (called by tests to configure mock behavior)
- `POST /mock/set-balance` — set a specific balance: `{ employeeId, locationId, available, used, total }`
- `POST /mock/set-mode` — set behavior mode: `{ mode: 'normal' | 'reject-next' | 'timeout-next' | 'error-next' | 'accept-all' }`
- `POST /mock/push-realtime` — simulate HCM pushing a realtime webhook to ExampleHR's `POST /v1/hcm/sync/realtime`
- `POST /mock/push-batch` — simulate HCM pushing a batch sync to ExampleHR's `POST /v1/hcm/sync/batch`
- `GET /mock/call-log` — return array of all HCM deduct/restore calls received (for asserting no extra calls were made)
- `POST /mock/reset` — reset all balances, mode, and call log to initial state

### Behavior Modes

| Mode | Behavior |
|------|---------|
| `normal` | Accept deductions if `available >= days`; return 422 if insufficient |
| `reject-next` | Return 422 on the next deduct call only, then auto-reset to `normal` |
| `timeout-next` | Delay 10s on the next deduct call (exceeds 5s timeout), then auto-reset |
| `error-next` | Return 500 on the next deduct call only, then auto-reset |
| `accept-all` | Accept all deductions regardless of balance (simulates HCM unreliability) |

## Key implementation rules

1. The mock server must be startable on a configurable port (default `4001`) via the `start(port)` helper.
2. State is purely in-memory — no SQLite, no files. Resets on `POST /mock/reset` or on server restart.
3. `timeout-next` mode: use `setTimeout(resolve, 10000)` before responding — do NOT use Jest fake timers inside the mock server itself.
4. The `push-realtime` and `push-batch` endpoints must know the ExampleHR service URL to push to (pass as constructor arg or env var `EXAMPLEHR_BASE_URL`).
5. All deduct/restore calls must be logged to an in-memory call log (append-only array) so tests can assert the circuit breaker prevented a call from being made.
6. The mock server `start()`/`stop()` helpers must return Promises for use in async `beforeAll`/`afterAll`.

## Do NOT load

- `docs/TRD.md`, `docs/CLEAN_CODE.md`, `docs/ERROR_HANDLING.md` — these govern production code, not the test mock
- `docs/PREMISES.md`, `docs/SCOPE.md`, `docs/ARCHITECTURE.md`, `docs/DATA_MODEL.md`
