# Test Strategy

---

## Philosophy

This project uses **agentic development**: tests are specifications, not afterthoughts. Every test is written before the implementation it covers. A failing test means the spec is not yet satisfied; a passing test means it is.

The goal is to make the system **robust against regressions from future development**, not merely to hit a coverage number.

---

## Test Pyramid

```
         ┌──────────────┐
         │   E2E (few)  │  Full HTTP stack + mock HCM server
         ├──────────────┤
         │ Integration  │  Service + real SQLite in-memory DB
         │  (moderate)  │
         ├──────────────┤
         │   Unit       │  Service logic, all dependencies mocked
         │   (many)     │
         └──────────────┘
```

### Unit Tests — `test/unit/`

**What:** Service-layer business logic in pure isolation. All database access and HCM calls are mocked via Jest `jest.fn()` or manual stubs.

**Focus areas:**
- `TimeOffRequestsService` state machine transitions (all valid and invalid paths).
- `BalancesService` defensive check logic (boundary values: `available === days`, `available < days`, `available > days`).
- `HcmSyncService` reconciliation logic — which requests are invalidated and which are not.
- Error mapping: HCM error shapes → correct internal exception types.
- Optimistic lock retry logic: 0 rows affected → retry → succeed; 0 rows affected → retry → fail → throw.

**Coverage target:** ≥ 90% branch coverage on all service files.

---

### Integration Tests — `test/integration/`

**What:** Service layer + TypeORM + SQLite in-memory database (`:memory:`). No mocks for the database layer. HCM calls are still mocked via Jest.

**Why separate from unit:** Catches SQL mistakes, TypeORM entity misconfigurations, index omissions, and transaction boundary bugs that pure mocks hide.

**Focus areas:**
- Overlap detection query: two requests that overlap return 409; adjacent requests (end = next start) do not.
- Optimistic lock: concurrent UPDATE with mismatched version → `ConflictException`.
- Batch upsert idempotency: same payload applied twice produces the same result with no duplicate sync log entries.
- Reconciliation query: correct requests are invalidated after a balance drop; requests with sufficient buffer are not.
- Sync log completeness: every balance change produces exactly one sync log entry with correct `source` and delta values.

---

### E2E Tests — `test/e2e/`

**What:** Full HTTP stack via `Supertest` against a running NestJS application, with an embedded **mock HCM server** (Express) that the NestJS service talks to.

**Setup:** Each test suite starts NestJS and the mock HCM server; SQLite uses a fresh in-memory database per suite.

**Focus areas (happy paths):**
- Submit → Approve → Cancel full lifecycle.
- Submit → Reject lifecycle.
- Balance correctly reflects deduction after approval and restoration after cancellation.
- Batch sync updates multiple balances and reconciles one invalidated request.
- Realtime webhook updates balance and invalidates a pending request.

**Focus areas (failure paths):**
- Approve with local insufficient balance → 422, no HCM call made.
- Approve with HCM returning rejection → 422, local balance unchanged.
- Approve with HCM timeout → 503, local balance unchanged.
- Cancel with HCM timeout → 503, request stays `APPROVED`.
- Approve while concurrent batch sync is in progress (race) → one succeeds, other returns 409.

**Focus areas (HCM injection scenarios):**
- Mid-test: mock HCM pushes a work anniversary bonus → balance increases → a previously-rejected-locally request can now be re-submitted and approved.
- Mid-test: mock HCM pushes a balance reduction → previously-approved request becomes `INVALIDATED`.

---

## Mock HCM Server — `test/mock-hcm/`

A lightweight Express server that simulates the HCM real-time API and batch push behavior.

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/hcm/deduct` | Deduct days from a balance. Returns updated balance or error. |
| `POST` | `/hcm/restore` | Restore days to a balance. Returns updated balance. |
| `GET` | `/hcm/balance/:employeeId/:locationId` | Return current mock balance. |
| `POST` | `/mock/set-balance` | Test control: set a specific balance for injection scenarios. |
| `POST` | `/mock/set-mode` | Test control: set server behavior (`normal \| reject-next \| timeout-next \| error-next`). |
| `POST` | `/mock/push-realtime` | Simulates HCM pushing a realtime webhook to the ExampleHR service. |
| `POST` | `/mock/push-batch` | Simulates HCM pushing a full batch sync to the ExampleHR service. |

### Behavior modes

| Mode | Description |
|------|-------------|
| `normal` | Accepts deductions if balance sufficient; returns errors if insufficient. |
| `reject-next` | Returns a 422 rejection for the next deduct call, then resets to `normal`. |
| `timeout-next` | Hangs the next deduct call for 10 s (exceeds 5 s timeout), then resets. |
| `error-next` | Returns 500 for the next deduct call, then resets to `normal`. |
| `accept-all` | Accepts all deductions regardless of balance (simulates HCM unreliability per C3). |

---

## Test Cases — Detailed Specification

### Unit: BalancesService

| ID | Scenario | Expected |
|----|----------|----------|
| U-B-01 | `available === days` | Passes check |
| U-B-02 | `available < days` | Throws `InsufficientBalanceException` |
| U-B-03 | `available > days` | Passes check |
| U-B-04 | Balance record not found | Throws `NotFoundException` |
| U-B-05 | Optimistic lock: version mismatch on write | Throws `ConflictException` |
| U-B-06 | Optimistic lock: retry succeeds on second attempt | Resolves |

### Unit: TimeOffRequestsService

| ID | Scenario | Expected |
|----|----------|----------|
| U-R-01 | Approve a `PENDING` request with sufficient balance + HCM success | Status → `APPROVED` |
| U-R-02 | Approve a `REJECTED` request | Throws `ConflictException` |
| U-R-03 | Approve a `APPROVED` request | Throws `ConflictException` |
| U-R-04 | Approve with HCM rejection | Throws `HcmRejectionException`; balance unchanged |
| U-R-05 | Approve with HCM timeout | Throws `HcmUnavailableException`; balance unchanged |
| U-R-06 | Reject a `PENDING` request | Status → `REJECTED`; no HCM call |
| U-R-07 | Reject an `APPROVED` request | Throws `ConflictException` |
| U-R-08 | Cancel an `APPROVED` request with HCM success | Status → `CANCELLED`; balance restored |
| U-R-09 | Cancel a `PENDING` request | Throws `ConflictException` |
| U-R-10 | Cancel with HCM timeout | Throws `HcmUnavailableException`; status and balance unchanged |

### Unit: HcmSyncService

| ID | Scenario | Expected |
|----|----------|----------|
| U-S-01 | Realtime update for existing balance | Upsert; 1 sync log entry |
| U-S-02 | Realtime update for new `(employeeId, locationId)` | Insert; 1 sync log entry |
| U-S-03 | Realtime update drops balance below a `PENDING` request's days | Request → `INVALIDATED` |
| U-S-04 | Realtime update drops balance below an `APPROVED` request's days | Request → `INVALIDATED` |
| U-S-05 | Realtime update does NOT drop balance below any in-flight request | No invalidations |
| U-S-06 | Batch sync with 3 records | 3 upserts; 3 sync log entries |
| U-S-07 | Batch sync re-run with same payload | No net change; idempotent |
| U-S-08 | Batch sync with one record causing invalidation | 1 request `INVALIDATED`; response reports `invalidated: 1` |

### Integration

| ID | Scenario | Expected |
|----|----------|----------|
| I-01 | Insert overlapping request | 409 CONFLICT |
| I-02 | Insert adjacent request (end == next start) | 201 Created |
| I-03 | Concurrent version conflict on balance write | `ConflictException` on second writer |
| I-04 | Batch upsert applied twice | Same final state; no duplicate sync log rows |
| I-05 | Reconciliation query selects only PENDING/APPROVED with days > available | Correct selection |
| I-06 | Sync log has correct `previous_available` and `new_available` after approval | Delta matches request.days |

### E2E

| ID | Scenario | Expected |
|----|----------|----------|
| E-01 | Submit → Approve → Cancel happy path | Status transitions correct; balance returns to original |
| E-02 | Submit → Reject | Status `REJECTED`; balance unchanged |
| E-03 | Submit with zero available balance | 422 INSUFFICIENT_BALANCE at submission |
| E-04 | Approve with HCM rejection (mock: `reject-next`) | 422 HCM_REJECTION; balance unchanged |
| E-05 | Approve with HCM timeout (mock: `timeout-next`) | 503 HCM_UNAVAILABLE; balance unchanged |
| E-06 | Cancel with HCM timeout | 503 HCM_UNAVAILABLE; status stays APPROVED |
| E-07 | Realtime webhook increases balance; previously-rejected local check now passes | Approve succeeds |
| E-08 | Realtime webhook drops balance; PENDING request → INVALIDATED | `GET /time-off-requests/:id` returns `INVALIDATED` |
| E-09 | Batch sync updates 5 balances; 1 APPROVED request invalidated | Response `{updated:5, invalidated:1}` |
| E-10 | Concurrent approvals for same balance (race) | One 200; one 409 CONFLICT |
| E-11 | HCM in `accept-all` mode accepts deduction despite zero balance | Service still rejects locally (C3 defense) |

### Resilience (E2E + Integration)

| ID | Scenario | Expected |
|----|----------|----------|
| R-01 | 5 consecutive HCM 500s → 6th approve attempt | Circuit OPEN; 6th call returns 503 immediately; mock call-log shows only 5 entries (no 6th network call) |
| R-02 | Circuit OPEN → 30s reset → 1 probe call succeeds | Circuit CLOSED; next call reaches HCM normally |
| R-03 | Cancel: HCM returns 503 on attempt 1, 200 on attempt 2 (retry) | Operation succeeds; 1 sync_log entry; balance restored |
| R-04 | Cancel: all 3 retry attempts exhausted (mock stays `error-next`) | `failed_retry` entry in sync_log; response is 503 HCM_UNAVAILABLE; request stays APPROVED |
| R-05 | `GET /health` — DB up + HCM up | `{ status: 'ok' }` HTTP 200 |
| R-06 | `GET /health` — HCM mock shut down | `{ status: 'degraded', checks: { hcm: { status: 'down' } } }` HTTP 200 |
| R-07 | `GET /health` — DB closed (force-close DataSource) | `{ status: 'down' }` HTTP 503 |
| R-08 | SIGTERM sent while approval in progress | Approval completes; process exits after drain with code 0 |

---

## Coverage Target

| Layer | Target |
|-------|--------|
| Unit — service branch coverage | ≥ 90% |
| Integration — query correctness | All SQL paths exercised |
| E2E — golden paths + failure modes | All 11 E2E cases above pass |
| Overall line coverage | ≥ 80% |

Coverage is reported via `npm run test:cov` using Jest's built-in Istanbul reporter. The `coverage/` directory is committed for the assignment deliverable.
