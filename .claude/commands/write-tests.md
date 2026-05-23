# /write-tests

Write the full test suite for the ExampleHR Time-Off Microservice.

## Scope

You are writing tests across all three layers:

- **Unit tests** (`test/unit/`) — service logic with all dependencies mocked via `jest.fn()`
- **Integration tests** (`test/integration/`) — service + real SQLite in-memory DB, HCM mocked
- **E2E tests** (`test/e2e/`) — full HTTP stack via Supertest + embedded mock HCM server

Assume all production code exists. You are writing tests against it, not implementing it.

## Documents to read before writing any code

- @docs/TEST_STRATEGY.md — the primary reference: test pyramid, all named test cases (U-B-*, U-R-*, U-S-*, I-*, E-*, R-*), mock HCM server modes, coverage targets
- @docs/USE_CASES.md — actor intent and edge cases for each use case; maps to E2E test scenarios
- @docs/API_SPEC.md — exact request/response shapes, error codes, HTTP status codes for E2E assertions
- @docs/RESILIENCE.md — resilience test cases R-01 through R-08: circuit breaker, retry, health check, graceful shutdown

## Key implementation rules

1. **Unit tests** — use Jest `jest.fn()` for all dependencies. Each test sets up its own state. No shared mutable state between tests. Test file per service: `balances.service.spec.ts`, `time-off-requests.service.spec.ts`, `hcm-sync.service.spec.ts`.
2. **Integration tests** — use TypeORM `DataSource` with `{ type: 'sqlite', database: ':memory:' }`. Run `synchronize: true` in `beforeAll`. Truncate tables in `beforeEach`. HCM adapter is still mocked (`jest.fn()`).
3. **E2E tests** — start NestJS app with `Test.createTestingModule()` + `app.init()` in `beforeAll`. Start mock HCM server (`test/mock-hcm/`) on port 4001. Reset mock state in `beforeEach`. Use `supertest(app.getHttpServer())` for all HTTP calls.
4. **Circuit breaker tests** (R-01, R-02) — use mock HCM `error-next` mode 5× to open circuit; assert 6th call never reaches mock (`GET /mock/call-log` length unchanged).
5. **Retry tests** (R-03, R-04) — mock HCM `error-next` resets after one call, so chain mode switches to test multi-attempt scenarios.
6. **Never use `setTimeout`** in tests. Use mock HCM `timeout-next` mode + Jest fake timers (`jest.useFakeTimers()`) to simulate the HCM timeout without waiting 10 real seconds.
7. **Overlap detection** (I-02) — adjacent requests where `request1.endDate === request2.startDate` must be allowed (they don't overlap).
8. **Race condition test** (E-10) — fire two concurrent `PATCH /approve` requests using `Promise.all([...])`. Assert one returns 200 and one returns 409.
9. **Coverage** — run with `jest --coverage`. Target ≥ 90% branch on service files, ≥ 80% overall line coverage.

## Test case IDs to implement

All cases from TEST_STRATEGY.md:
- **Unit BalancesService:** U-B-01 through U-B-06
- **Unit TimeOffRequestsService:** U-R-01 through U-R-10
- **Unit HcmSyncService:** U-S-01 through U-S-08
- **Integration:** I-01 through I-06
- **E2E:** E-01 through E-11
- **Resilience:** R-01 through R-08

## Do NOT load

- `docs/TRD.md` — design rationale not needed for test implementation
- `docs/DATA_MODEL.md` — entity schema already exists; read from source if needed
- `docs/CLEAN_CODE.md` — production code conventions; tests have their own patterns
- `docs/PREMISES.md` and `docs/SCOPE.md` — not needed for test writing
