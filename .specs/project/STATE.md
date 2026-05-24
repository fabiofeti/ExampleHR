# State

**Last Updated:** 2026-05-24T02:30:00Z
**Current Work:** ALL FEATURES COMPLETE. F-09 committed + pushed. PR open on feat/Tasks-09. M5 deliverable achieved.

---

## Recent Decisions (Last 60 days)

### AD-001: HCM-First Dual-Write Pattern (2026-05-23)

**Decision:** Call HCM deduction API first; write to local DB only on HCM success.
**Reason:** HCM is the source of truth. Local-first would require compensating transactions on HCM rejection, adding complexity with no correctness benefit.
**Trade-off:** Narrow failure window (HCM succeeds, DB commit crashes) leaves systems temporarily diverged. Acceptable because next inbound sync self-heals.
**Impact:** `TimeOffRequestsService.approve()` must call HCM before any DB write. DB transaction wraps balance update + status update + sync_log insert atomically.

---

### AD-002: Eventual Consistency for Balance Reads (2026-05-23)

**Decision:** `GET /balances` returns locally cached value; real-time accuracy enforced only at write time.
**Reason:** Calling HCM on every read couples availability to HCM uptime and degrades latency for all employees.
**Trade-off:** Balance shown to employee may lag HCM by time since last sync event.
**Impact:** `BalancesController` reads from local `balances` table only. No HCM call on GET.

---

### AD-003: Defensive Local Check Before HCM (2026-05-23)

**Decision:** Always check `balance.available >= request.days` locally before calling HCM deduction API.
**Reason:** HCM error responses are authoritative but not guaranteed (may silently accept invalid requests). Local check prevents obvious overdrafts and avoids wasted HCM round-trips.
**Trade-off:** Not a replacement for HCM validation — HCM may still reject even if local check passes.
**Impact:** `BalancesService.defensiveCheck()` called at the start of every approval flow, before the HCM adapter is invoked.

---

### AD-004: Optimistic Locking on Balances Table (2026-05-23)

**Decision:** `balances` table has a `version` integer column. Every UPDATE includes `WHERE version = :expected`. If 0 rows affected → `BalanceConflictException` → retry once → 409 if still failing.
**Reason:** SQLite file-level locking makes pessimistic locking (`SELECT FOR UPDATE`) serialize all balance writes globally, killing throughput during HCM calls.
**Trade-off:** Retry logic needed at application layer. Caller may see 409 under high concurrency.
**Impact:** `BalancesService.deductWithLock()` and `restoreWithLock()` implement this pattern. One internal retry before surfacing 409.

---

### AD-005: Batch Sync Reconciliation (2026-05-23)

**Decision:** After every batch sync (and realtime webhook), run a reconciliation query to find PENDING/APPROVED requests where `days > balance.available` and transition them to `INVALIDATED`.
**Reason:** HCM may lower a balance below what an already-approved request assumed. Left unresolved, this causes silent overdrafts.
**Trade-off:** Reconciliation adds latency to batch sync processing (acceptable — batch is not latency-sensitive).
**Impact:** `HcmSyncService` runs reconciliation after every upsert operation. Response includes `invalidated: N` count.

---

### AD-006: REST Over GraphQL (2026-05-23)

**Decision:** REST API with versioned routes (`/v1/`).
**Reason:** Consumer set is fixed (single frontend + HCM webhooks). Query shape is simple and static. GraphQL flexibility is not needed. REST fits naturally with HCM webhook pattern.
**Trade-off:** No dynamic field selection for consumers.
**Impact:** All endpoints defined in `docs/API_SPEC.md`. NestJS controllers with `ValidationPipe`.

---

### AD-007: Circuit Breaker on HCM (opossum) (2026-05-23)

**Decision:** `opossum` circuit breaker wraps all `HcmAdapterService` outbound calls. Opens at 50% error rate over 10 calls; resets after 30s.
**Reason:** Without a circuit breaker, sustained HCM downtime causes every write request to block for 5s timeout, exhausting threads and degrading reads too.
**Trade-off:** During OPEN state, writes fail fast (503) even if HCM recovers within the reset window. Auto-recovery via HALF_OPEN probe.
**Impact:** `HcmAdapterService` holds circuit breaker instance as class singleton. Config via `ConfigService` (env vars).

---

### AD-008: Dependency Inversion for HCM Adapter (2026-05-23)

**Decision:** `IHcmAdapter` interface defined in `src/hcm-sync/ports/hcm-adapter.port.ts`. Services inject via `HCM_ADAPTER_TOKEN`, not the concrete class.
**Reason:** Enables clean mock substitution in all test layers without changing service code. Also makes future adapter swap (Workday → SAP) zero-impact on business logic.
**Trade-off:** Slight indirection via token injection.
**Impact:** All services use `@Inject(HCM_ADAPTER_TOKEN)`. Tests override with `{ provide: HCM_ADAPTER_TOKEN, useValue: mockAdapter }`.

---

### AD-009: Retry Only on Idempotent HCM Calls (2026-05-23)

**Decision:** Exponential backoff retry (1s/2s/4s, max 3 attempts) applies only to `restore()` (cancel). No retry on `deduct()` (approve) until HCM idempotency key support is confirmed.
**Reason:** A second `deduct()` call without a confirmed idempotency key could double-deduct the balance.
**Trade-off:** Failed approvals are not retried — user must re-attempt. Cancellations are more resilient.
**Impact:** Retry logic in `HcmAdapterService.restore()`. TRD Open Question #4 must be resolved before enabling deduct retry.

---

### AD-010: No Code Written Manually (2026-05-23)

**Decision:** This project uses agentic development — Claude Code generates all implementation guided by TRD, tests, and scoped slash commands. No handwritten source code.
**Reason:** Assignment requirement. TRD and test suite are the primary deliverables; code quality is measured by how well the spec is expressed.
**Trade-off:** Spec must be unambiguous enough for agent to implement correctly.
**Impact:** Implementation sessions use `.claude/commands/*.md` scoped commands to load only relevant docs.

---

## Active Blockers

### B-001: HCM API Shape Not Confirmed

**Discovered:** 2026-05-23
**Impact:** Cannot implement `HcmAdapterService` HTTP calls without knowing field names, auth headers, and error response shape.
**Workaround:** Mock HCM server (`test/mock-hcm/`) uses a reasonable assumed shape. Implementation can proceed with mock.
**Resolution:** Confirm with HCM integration team (TRD Open Question #1). Update `HcmAdapterService` and mock server to match.

### B-002: HCM Idempotency Key Not Confirmed

**Discovered:** 2026-05-23
**Impact:** Cannot enable retry on `deduct()` (approval) until HCM confirms it honors `X-Idempotency-Key`. Without confirmation, retry risks double-deduction.
**Workaround:** Retry disabled on deduct. Approval failures are non-retryable (user must re-attempt).
**Resolution:** TRD Open Question #4. When confirmed, enable retry in `HcmAdapterService.deduct()`.

---

## Lessons Learned

*(None yet — populated during implementation)*

---

## Quick Tasks Completed

| # | Description | Date | Commit | Status |
|---|-------------|------|--------|--------|
| 001 | Full TRD + 11 documentation files | 2026-05-23 | f170356 | ✅ Done |
| 002 | Resilience, clean code, error handling docs + 7 scoped commands | 2026-05-23 | — | ✅ Done |

---

## Deferred Ideas

Ideas captured during spec work that belong in Phase 2.

- [ ] Pluggable HCM adapters (Workday, SAP, BambooHR) — captured during: SCOPE.md
- [ ] Auto re-evaluation of INVALIDATED requests when balance recovers — captured during: USE_CASES.md (UC-06)
- [ ] Employee/manager push notifications on invalidation — captured during: TRD.md (C5 solution)
- [ ] Scheduled daily reconciliation cron job — captured during: SCOPE.md Phase 2
- [ ] Multi-tenant isolation — captured during: SCOPE.md Phase 2
- [ ] Performance test suite (NFR: 10k batch records in <30s) — captured during: TRD.md NFRs

---

## Todos

- [ ] Confirm HCM API field names and auth headers with integration team (unblocks B-001)
- [ ] Confirm HCM idempotency key support (unblocks B-002, enables deduct retry)
- [ ] Initialize NestJS project scaffold (`nest new`)
- [ ] Run `break into tasks` for each feature before implementing

---

## Preferences

**Model Guidance Shown:** never
