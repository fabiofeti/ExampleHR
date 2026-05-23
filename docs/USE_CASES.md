# Use Cases

Actors: **Employee**, **Manager**, **HCM System** (external), **Scheduler** (internal cron, future scope).

---

## UC-01: Employee Views Current Balance

**Actor:** Employee  
**Trigger:** Employee opens the time-off request screen.

**Preconditions:**
- At least one balance record exists for `(employeeId, locationId)`.

**Main Flow:**
1. Employee sends `GET /balances/:employeeId/:locationId`.
2. Service returns the locally cached balance (available, used, total).

**Postconditions:**
- No state change. Read-only.

**Edge Cases:**
- Balance record does not exist → `404 Not Found`.
- HCM has updated the balance since last sync → value may be stale; this is acceptable per Premise 8.

---

## UC-02: Employee Submits a Time-Off Request

**Actor:** Employee  
**Trigger:** Employee fills out the request form and submits.

**Preconditions:**
- Balance record exists for `(employeeId, locationId)`.
- `endDate >= startDate`.
- `days > 0`.

**Main Flow:**
1. Employee sends `POST /time-off-requests` with `{employeeId, locationId, startDate, endDate, leaveType, days}`.
2. Service creates the request with status `PENDING`.
3. Service responds `201 Created` with the new request object.

**Postconditions:**
- A `TimeOffRequest` record exists with status `PENDING`.
- Balance is **not** deducted yet (deduction happens on approval).

**Edge Cases:**
- Overlapping request for same employee/location/dates already exists and is `PENDING` or `APPROVED` → `409 Conflict`.
- `days` exceeds available balance (local check) → `422 Unprocessable Entity` with reason `INSUFFICIENT_BALANCE`.
- Invalid `(locationId, leaveType)` combination → HCM will reject on approval; submission is still allowed.

**Note:** Submission is intentionally lightweight — no HCM call at submit time. The HCM call happens at approval to minimize HCM API load and because requests may be rejected by managers before ever reaching HCM.

---

## UC-03: Manager Approves a Time-Off Request

**Actor:** Manager  
**Trigger:** Manager reviews a pending request and clicks "Approve".

**Preconditions:**
- Request exists and is in `PENDING` status.

**Main Flow:**
1. Manager sends `PATCH /time-off-requests/:id/approve`.
2. Service performs defensive local balance check: `balance.available >= request.days`.
3. Service calls HCM real-time API to deduct `request.days` from `(employeeId, locationId)`.
4. HCM responds with success and the updated balance.
5. Service deducts `request.days` from the local balance (optimistic lock write).
6. Service transitions request status to `APPROVED`.
7. Service responds `200 OK` with updated request.

**Postconditions:**
- Request status is `APPROVED`.
- Local balance `available` is reduced by `request.days`.
- Sync log entry appended with source `request_approve`.

**Edge Cases:**
- Local balance insufficient → reject with `422 INSUFFICIENT_BALANCE` before calling HCM.
- HCM returns error (invalid dimension or insufficient balance per HCM) → reject with `422 HCM_REJECTION`, do not modify local state.
- HCM is unreachable (timeout/5xx) → reject with `503 HCM_UNAVAILABLE`, do not modify local state.
- Optimistic lock conflict (concurrent approval or batch sync) → retry once; if still failing, return `409 CONFLICT`.
- Request is not in `PENDING` status → `409 CONFLICT` with current status.

---

## UC-04: Manager Rejects a Time-Off Request

**Actor:** Manager  
**Trigger:** Manager reviews a pending request and clicks "Reject".

**Preconditions:**
- Request exists and is in `PENDING` status.

**Main Flow:**
1. Manager sends `PATCH /time-off-requests/:id/reject` with optional `{reason}`.
2. Service transitions request status to `REJECTED`.
3. Service responds `200 OK`.

**Postconditions:**
- Request status is `REJECTED`.
- Balance is unchanged (no HCM call needed).

**Edge Cases:**
- Request is not in `PENDING` status → `409 CONFLICT`.

---

## UC-05: Employee or Manager Cancels an Approved Request

**Actor:** Employee or Manager  
**Trigger:** Plans change; the time-off period should be restored.

**Preconditions:**
- Request exists and is in `APPROVED` status.

**Main Flow:**
1. Actor sends `PATCH /time-off-requests/:id/cancel`.
2. Service calls HCM real-time API to restore `request.days` to `(employeeId, locationId)`.
3. HCM responds with success and updated balance.
4. Service adds `request.days` back to local balance (optimistic lock write).
5. Service transitions request status to `CANCELLED`.
6. Service responds `200 OK`.

**Postconditions:**
- Request status is `CANCELLED`.
- Local balance `available` is increased by `request.days`.
- Sync log entry appended with source `request_cancel`.

**Edge Cases:**
- HCM restoration call fails → return `503 HCM_UNAVAILABLE`; do not change local state or request status. Log the failure for manual reconciliation.
- Optimistic lock conflict → retry once; if failing, return `409 CONFLICT`.
- Request is not in `APPROVED` status → `409 CONFLICT`.

---

## UC-06: HCM Pushes a Real-Time Balance Update

**Actor:** HCM System  
**Trigger:** Work anniversary bonus, admin correction, or any HCM-side event that changes an employee's balance.

**Preconditions:**
- HCM has authenticated the webhook call (assumed pre-authenticated at the gateway level).

**Main Flow:**
1. HCM sends `POST /hcm/sync/realtime` with `{employeeId, locationId, available, used, total}`.
2. Service upserts the balance record for `(employeeId, locationId)`.
3. Service appends a sync log entry with source `realtime_webhook`.
4. Service responds `200 OK`.
5. Service checks if any `PENDING` requests for this employee/location now exceed the updated available balance; if so, marks them `INVALIDATED` and notifies (log only in Phase 1).

**Postconditions:**
- Local balance reflects HCM's pushed value.
- Sync log updated.
- Any newly-invalidated pending requests are flagged.

**Edge Cases:**
- `(employeeId, locationId)` pair does not exist in local DB → create new balance record (first sync for this employee/location).
- Payload is missing required fields → `400 Bad Request`.

---

## UC-07: HCM Pushes a Full Batch Balance Sync

**Actor:** HCM System  
**Trigger:** Scheduled daily/weekly full sync, or manual trigger by an admin.

**Preconditions:**
- Payload contains a complete list of balance records for all employees/locations managed by this HCM instance.

**Main Flow:**
1. HCM sends `POST /hcm/sync/batch` with `{ balances: [{employeeId, locationId, available, used, total}, ...] }`.
2. Service processes all records in a single transaction: upsert each `(employeeId, locationId)` balance.
3. Service appends one sync log entry per updated record with source `batch`.
4. Service runs reconciliation: for every `PENDING` or `APPROVED` request whose `days` now exceed the employee's updated available balance, mark as `INVALIDATED`.
5. Service responds `200 OK` with `{ updated: N, invalidated: M }`.

**Postconditions:**
- All local balances match the batch payload.
- Stale records (employees/locations no longer in the payload) are left as-is with a staleness flag (not deleted, for auditability).
- Sync log updated.
- Reconciliation report logged.

**Edge Cases:**
- Batch payload is empty → treat as no-op, return `200 OK`.
- Partial failure on one record → continue processing remaining records; report failures in response.
- Optimistic lock conflict during upsert → retry that individual record up to 3 times.
