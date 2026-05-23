# Project Scope

---

## In Scope

### Time-Off Request Lifecycle
- **Submit** a time-off request (`employeeId`, `locationId`, `startDate`, `endDate`, `leaveType`, `days`).
- **Approve** a pending request (manager action) — triggers HCM balance deduction.
- **Reject** a pending request (manager action) — no balance impact.
- **Cancel** an approved request (employee or manager action) — triggers HCM balance restoration.
- **List** requests filtered by employee, status, date range.
- **Get** a single request by ID.

### Balance Management
- Retrieve current balance for `(employeeId, locationId)` from local cache.
- Defensive local balance check before any HCM deduction call.
- Apply HCM's response (success or error) as the authoritative outcome.
- Optimistic-lock-protected balance writes.

### HCM Synchronization — Inbound
- **Real-time webhook** (`POST /hcm/sync/realtime`): accept a single balance update pushed by HCM; upsert local balance; append to sync log.
- **Batch ingest** (`POST /hcm/sync/batch`): accept a full balance corpus from HCM; upsert all rows; trigger reconciliation of any in-flight (pending/approved) requests against new balances.

### HCM Synchronization — Outbound
- **Real-time deduction call** to HCM when a request is approved.
- **Real-time restoration call** to HCM when an approved request is cancelled.

### Audit / Sync Log
- Append-only log recording every balance change: source (`realtime_webhook | batch | request_approve | request_cancel`), previous value, new value, timestamp, actor.

### Mock HCM Server (Test Fixture)
- Lightweight Express server embedded in the test suite.
- Simulates HCM real-time API (balance get/deduct/restore) with configurable failure modes.
- Simulates HCM batch push endpoint.
- Supports injecting work-anniversary bonus events mid-test.

---

## Out of Scope

| Area | Reason |
|------|--------|
| Authentication & authorization | Assumed to be handled by an API gateway or a separate auth service upstream. All requests are treated as pre-authenticated. |
| Employee master data management | Owned by HCM or a separate identity service. |
| Location master data management | Owned by HCM. |
| Payroll processing | Separate domain; this service only manages leave balances. |
| Leave policy configuration | Which leave types are valid per location is assumed to come from HCM validation responses. |
| Push notifications to employees | Notification delivery is a separate concern. |
| UI / frontend | Backend microservice only. |
| Multi-HCM support | Single HCM adapter per deployment. Adapter selection is a deployment concern, not a feature of this service. |
| HCM adapter for specific vendors | The service defines an `HcmAdapter` interface; the mock server satisfies it. Real Workday/SAP adapters are outside this scope. |

---

## Phase Boundaries

### Phase 1 (this assignment)
All in-scope items above. The mock HCM server stands in for any real HCM.

### Phase 2 (future, not designed here)
- Pluggable HCM adapters (Workday, SAP, BambooHR).
- Scheduled balance reconciliation job (cron-driven full sync).
- Manager dashboard and notification hooks.
- Multi-tenant isolation.
