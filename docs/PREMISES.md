# Premises & Assumptions

This document captures the non-negotiable truths the Time-Off Microservice is built on. Any design decision that contradicts a premise here must first update this document with explicit justification.

---

## 1. HCM is the Source of Truth

The Human Capital Management system (e.g., Workday, SAP) owns the canonical leave balance for every employee. ExampleHR maintains a **local cache** of balances purely to:

- Serve fast balance reads without an HCM round-trip on every request.
- Perform defensive pre-validation before calling HCM.
- Preserve a record for auditing and divergence detection.

**Consequence:** If ExampleHR's local balance and HCM's balance disagree, HCM wins. Reconciliation must update the local cache toward HCM's value, never the other way around.

---

## 2. Balance Dimensions are `(employeeId, locationId)`

Every balance value is scoped to a specific employee at a specific location. There is no global "employee balance" — the same employee can have different leave entitlements at different locations (e.g., local statutory requirements).

**Consequence:** All API endpoints, database keys, and HCM payloads must carry both `employeeId` and `locationId`. Partial keys are invalid.

---

## 3. HCM Provides Two Sync Mechanisms

| Mechanism | Direction | Trigger | Payload |
|-----------|-----------|---------|---------|
| Real-time API | ExampleHR → HCM | On request submit/approve | Single `(employeeId, locationId, delta)` |
| Real-time webhook | HCM → ExampleHR | HCM-side events (anniversary, admin edits) | Single balance update |
| Batch endpoint | HCM → ExampleHR | Scheduled or manual | Full balance corpus |

Both inbound paths must be handled. The service must not assume only one will be used.

---

## 4. HCM Error Responses are Authoritative but Not Guaranteed

When ExampleHR submits a time-off deduction to HCM:

- HCM **may** respond with an error if the balance is insufficient or the dimension combination is invalid.
- HCM **may not always** return such an error — it can silently accept an invalid request.

**Consequence:** ExampleHR must perform its own defensive balance check **before** calling HCM. A local rejection should prevent the HCM call from being made in cases where the local cache clearly shows insufficient balance. This is a defense-in-depth measure, not a replacement for HCM validation.

---

## 5. Agentic Development Constraint

No source code is written manually. The TRD and test specifications are the primary deliverables. Claude Code (or equivalent agentic tooling) generates all implementation files. The quality bar is:

- TRD must be precise enough that an agent can implement it without ambiguity.
- Test cases must cover all edge cases, including HCM failures and race conditions.
- Coverage must be verifiable and reproducible.

---

## 6. Concurrency is a Real Concern

Multiple requests for the same `(employeeId, locationId)` balance can arrive simultaneously. The system must guard against:

- Two concurrent requests both passing the local balance check before either is committed.
- A batch sync overwriting a balance mid-request.

**Consequence:** Optimistic locking (version column) is applied on the `balances` table. Any write that detects a version conflict must retry or fail with a clear error.

---

## 7. The Service Does Not Own Employee or Location Master Data

Employee records and location records are owned by HCM or a separate identity service. This microservice:

- Stores only the IDs it receives.
- Does not validate that an `employeeId` or `locationId` is a "real" entity beyond what HCM confirms during balance operations.
- Does not manage employee lifecycle (hire, terminate, transfer).

---

## 8. Eventual Consistency is Acceptable for Balance Reads

Balance reads (`GET /balances/:employeeId/:locationId`) return the locally cached value. This value may lag HCM by the time since the last sync event. This is acceptable because:

- HCM validation happens at request submission time, not at balance read time.
- The UX goal is to show the employee a "likely accurate" value quickly, not a guaranteed real-time value.

Real-time accuracy is enforced at the point of deduction, not at the point of display.
