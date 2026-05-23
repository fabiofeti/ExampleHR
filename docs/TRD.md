# Technical Requirements Document (TRD)
# ExampleHR — Time-Off Microservice

**Version:** 1.0  
**Date:** 2026-05-23  
**Author:** Engineering (agentic development)

---

## 1. Background

ExampleHR provides a time-off management interface for employees and managers. The Human Capital Management (HCM) system (e.g., Workday, SAP) is the authoritative source of truth for employment data including leave balances. This microservice acts as the transactional layer between the employee-facing UI and the HCM.

See [`PREMISES.md`](PREMISES.md) for foundational constraints and [`SCOPE.md`](SCOPE.md) for feature boundaries.

---

## 2. Challenges

### C1 — Dual-Write Consistency
When a time-off request is approved, a deduction must be recorded in both ExampleHR's local DB and HCM. If one write succeeds and the other fails, the systems diverge. This is the classic dual-write problem.

**Risk:** Employee sees an incorrect balance; manager makes decisions on stale data.

### C2 — External Balance Mutations
HCM can change a balance at any time without notifying ExampleHR first (e.g., work anniversary bonus, year-start refresh, admin correction). ExampleHR's cached balance can become stale between HCM webhook events.

**Risk:** Employee is shown a balance that does not reflect their current entitlement.

### C3 — HCM Unreliability
HCM's error responses are authoritative but not guaranteed. HCM may silently accept a deduction request even when the balance is insufficient. HCM can also be temporarily unavailable.

**Risk:** Overdraft of leave balance; cascading failures if service blocks on HCM calls.

### C4 — Race Conditions
Two concurrent approval requests for overlapping leave periods by the same employee can both pass local balance checks before either HCM call completes.

**Risk:** Double-spend of leave balance.

### C5 — Batch Sync Invalidation
A batch sync from HCM may lower an employee's balance below what an in-flight `PENDING` or `APPROVED` request assumes. Approved requests that were valid when approved may become over-budget after a sync.

**Risk:** Data integrity issues; incorrect balance reflects committed but now over-budget requests.

### C6 — HCM Downtime
HCM may be unavailable for minutes or hours. Without a circuit breaker, every write request during an outage blocks for the full timeout (5s) before failing. Under concurrent load this exhausts threads and degrades the entire service, including read-only operations that do not need HCM at all.

**Risk:** Cascading service degradation; read endpoints become slow during HCM outage.

### C7 — Partial Write Window
There is a narrow window between step 2 (HCM deduction succeeds) and step 3 (local DB commit completes) in the approval flow. A crash in this window leaves HCM's balance lower than ExampleHR's local cache. The two systems diverge silently.

**Risk:** Employee sees a higher balance than they actually have; subsequent requests may overdraft.

---

## 3. Proposed Solution

### 3.1 Architecture

A single NestJS microservice with three primary modules:

| Module | Responsibility |
|--------|---------------|
| `balances` | Local balance cache, optimistic locking, defensive checks |
| `time-off-requests` | Request lifecycle state machine |
| `hcm-sync` | HCM adapter calls (outbound) + inbound webhook/batch handlers |

See [`ARCHITECTURE.md`](ARCHITECTURE.md) for diagrams.

### 3.2 Solving C1 — Dual-Write Consistency

**Decision:** HCM is called first; local DB write happens only on HCM success.

**Flow for approval:**
1. Local defensive check (C3 mitigation).
2. Call HCM deduction API.
3. On HCM success: write local balance update + request status in a single DB transaction.
4. On HCM failure: return error; no local state change.

**Tradeoff:** If the HCM call succeeds but the local DB write fails (e.g., DB crash after step 2), HCM has deducted but ExampleHR has not. This is a narrow failure window that results in ExampleHR showing a higher-than-actual balance. Recovery path: the next batch sync or real-time webhook from HCM will correct the local value. An alert on the sync log divergence triggers manual review if needed.

**Why not local-first?** If ExampleHR deducts locally first and then HCM rejects, ExampleHR must roll back. This requires a compensating transaction and is more complex without giving correctness benefits — HCM's value still wins.

### 3.3 Solving C2 — External Balance Mutations

**Decision:** Accept eventual consistency for balance reads; enforce HCM accuracy at write time.

- `GET /balances` returns local cache (fast, may be slightly stale).
- Inbound real-time webhook endpoint (`POST /hcm/sync/realtime`) upserts local balance immediately.
- Inbound batch endpoint (`POST /hcm/sync/batch`) upserts all balances in a transaction.
- After every inbound sync, run a reconciliation pass over in-flight requests (UC-06, UC-07).

### 3.4 Solving C3 — HCM Unreliability

**Defensive local check (before every HCM write call):**

```
if (balance.available < request.days) → reject locally; do not call HCM
```

This catches obvious overdrafts without relying on HCM. HCM remains the final authority and may still reject even if the local check passes.

**HCM unavailability:** All outbound HCM calls have a configurable timeout (default 5 s) and return `503 HCM_UNAVAILABLE` to the caller if HCM does not respond. No retry on approval (to avoid duplicate deductions). Cancellation may retry once with idempotency key.

### 3.5 Solving C4 — Race Conditions

**Optimistic locking on `balances`:**

Each balance row has a `version` integer. Any UPDATE includes `WHERE version = :currentVersion`. If another write has already incremented the version, the update affects 0 rows and a `ConflictException` is thrown. The caller receives `409 CONFLICT` and must re-fetch and retry.

The NestJS request handler for approval will retry once internally on a version conflict before surfacing the error to the caller.

### 3.6 Solving C5 — Batch Sync Invalidation

After a batch sync upserts all balances, the service runs a reconciliation query:

```sql
SELECT r.* FROM time_off_requests r
JOIN balances b ON b.employee_id = r.employee_id AND b.location_id = r.location_id
WHERE r.status IN ('PENDING', 'APPROVED')
AND r.days > b.available
```

Each matched request is transitioned to `INVALIDATED` status. A log entry is written. In Phase 1, this is logged only. Phase 2 would add employee/manager notifications.

### 3.7 Solving C6 — HCM Downtime

**Decision:** Circuit breaker (`opossum`) wrapping all `HcmAdapterService` outbound calls.

- States: `CLOSED → OPEN (50% error rate over 10 calls) → HALF_OPEN (after 30s) → CLOSED`.
- On `OPEN`: fail fast with `HcmUnavailableException` — no network call, sub-millisecond response.
- Read endpoints continue serving cached data during OPEN state.
- Write endpoints return `503 HCM_UNAVAILABLE` immediately (no thread blocking).
- Circuit auto-recovers: single probe call on `HALF_OPEN`; success closes it.

See [`RESILIENCE.md`](RESILIENCE.md) for full configuration.

### 3.8 Solving C7 — Partial Write Window

**Decision:** Accept the narrow failure window; rely on sync-log divergence detection for recovery.

The window exists between HCM deduction succeeding (step 2) and the local DB commit completing (step 3). If the process crashes in this window:
- HCM balance is lower than ExampleHR cache shows.
- The next inbound sync (realtime webhook or batch) pushes the authoritative balance.
- The `sync_log` records every balance change with `previous_available` and `new_available`. A gap between the expected delta and the actual value is detectable.
- A `WARN` log `MANUAL_RECONCILIATION_REQUIRED` is emitted when the divergence is detected.

**Why this is acceptable:** The window is sub-second (local SQLite write is fast). HCM-first ordering ensures the system never approves without HCM's agreement. The over-reporting direction (showing more balance than HCM has) is less harmful than under-reporting.

---

## 4. Data Model

See [`DATA_MODEL.md`](DATA_MODEL.md) for the full ER diagram. Key tables:

| Table | Key Columns |
|-------|------------|
| `balances` | `employee_id`, `location_id`, `available`, `used`, `total`, `version`, `last_synced_at` |
| `time_off_requests` | `id`, `employee_id`, `location_id`, `leave_type`, `start_date`, `end_date`, `days`, `status`, `created_at`, `updated_at` |
| `sync_log` | `id`, `employee_id`, `location_id`, `source`, `previous_available`, `new_available`, `actor`, `created_at` |

---

## 5. API Design

See [`API_SPEC.md`](API_SPEC.md) for full endpoint contracts.

**Choice: REST over GraphQL**

GraphQL was considered and rejected for this scope:
- The consumer set is well-known (single frontend + HCM webhooks).
- The query shape is fixed and simple; GraphQL's flexibility is not needed.
- REST fits naturally with the webhook pattern HCM uses for inbound sync.
- NestJS REST tooling (pipes, interceptors, validation) is mature and sufficient.

---

## 6. Alternatives Considered

### 6.1 Event Sourcing for Balance State

**Approach:** Store all balance changes as events; derive current balance by replaying the event log.

**Pros:** Perfect audit trail; easy to replay/debug; no dual-write risk (events are the state).

**Cons:** Significantly more complex infrastructure (event store, projections); overkill for this scope; SQLite does not naturally support event sourcing patterns.

**Decision:** Rejected. The `sync_log` table gives sufficient auditability for this scope without the infrastructure overhead.

### 6.2 Distributed Saga for Approval

**Approach:** Use a saga/orchestrator pattern to coordinate the HCM call and local DB write as separate steps with compensating transactions.

**Pros:** Formal correctness guarantees; well-understood pattern for distributed writes.

**Cons:** Requires a message broker (Kafka, RabbitMQ) or a saga orchestrator; far exceeds the scope and tech constraints (SQLite, single service).

**Decision:** Rejected. HCM-first with sync-log-based divergence detection is sufficient for this scope.

### 6.3 Synchronous HCM Balance Fetch on Every Read

**Approach:** `GET /balances` always calls HCM in real-time instead of serving cached data.

**Pros:** Always-accurate balance reads.

**Cons:** Every balance page load makes an HCM API call; tight coupling to HCM availability for read operations; poor latency for employees.

**Decision:** Rejected. Eventual consistency for reads with real-time accuracy at write time is the correct tradeoff per Premise 8.

### 6.4 Pessimistic Locking on `balances`

**Approach:** `SELECT ... FOR UPDATE` to lock the balance row during the approval flow.

**Pros:** Simpler to reason about than optimistic locking; no retry needed.

**Cons:** SQLite's locking model is file-level; long HCM calls (during which the lock would be held) would serialize all balance writes globally; poor throughput under load.

**Decision:** Rejected in favor of optimistic locking with retry.

---

## 7. Non-Functional Requirements

| Requirement | Target |
|-------------|--------|
| Balance read latency | < 50 ms p99 (cache hit) |
| Approval latency | < HCM round-trip + 100 ms overhead |
| Batch sync throughput | 10,000 balance records in < 30 s |
| HCM call timeout | 5 s (configurable) |
| Test coverage | ≥ 80% on service-layer business logic |
| Audit log retention | Append-only; no deletion in Phase 1 |

---

## 8. Security Considerations

- All endpoints assume pre-authenticated requests from an upstream API gateway.
- The HCM webhook endpoint (`POST /hcm/sync/*`) must be restricted to the HCM's known IP range at the gateway level.
- No PII beyond employee IDs is stored; employee names, emails, etc. are not in scope.
- SQLite file must have filesystem-level read restrictions in production.

---

## 9. Open Questions

| # | Question | Owner | Due |
|---|----------|-------|-----|
| 1 | What is the exact HCM API shape for the real-time deduction call? (field names, auth headers) | HCM integration team | Before implementation |
| 2 | Should `INVALIDATED` requests be automatically re-evaluated when balance recovers? | Product | Phase 2 |
| 3 | What is the expected frequency and volume of HCM batch syncs? | HCM integration team | Before load testing |
| 4 | Is idempotency key required on the HCM deduction API to prevent duplicate deductions on retry? | HCM integration team | Before implementation |
