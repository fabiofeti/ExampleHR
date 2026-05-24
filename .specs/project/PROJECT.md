# ExampleHR Time-Off Microservice

**Vision:** A NestJS + SQLite microservice that manages the full lifecycle of employee time-off requests while keeping leave balances synchronized with an external Human Capital Management (HCM) system — the authoritative source of truth.
**For:** Employees (submitting/cancelling requests) and managers (approving/rejecting requests), via a frontend that is out of scope for this service.
**Solves:** The dual-write consistency problem between a local request-management layer and an external HCM balance ledger, including race conditions, batch sync invalidation, and HCM downtime resilience.

---

## Goals

- **Correct request lifecycle** — PENDING → APPROVED/REJECTED, APPROVED → CANCELLED state machine enforced with HCM-first dual-write; no silent overdrafts.
- **Balance integrity under concurrency** — Optimistic locking (version column) on the `balances` table prevents concurrent requests from double-spending the same leave entitlement.
- **Resilient HCM integration** — Circuit breaker (`opossum`) fails fast during HCM outages; reads remain available; service self-heals via HALF_OPEN probe after 30s.
- **Eventual consistency by design** — Balance reads are served from local cache (fast, no HCM round-trip); real-time accuracy is enforced only at write time (approval/cancel).
- **Coverage ≥ 80%** — Full test pyramid (unit + integration + E2E) with embedded mock HCM server.

---

## Tech Stack

**Core:**

- Framework: NestJS (Node.js)
- Language: TypeScript (strict mode)
- Database: SQLite via TypeORM

**Key dependencies:**

- `opossum` — circuit breaker wrapping all HcmAdapterService outbound calls
- `class-validator` + `class-transformer` — DTO validation and transformation
- `@nestjs/terminus` — `/health` endpoint (DB + HCM checks)
- `jest` + `supertest` — unit, integration, and E2E test layers
- `express` — embedded mock HCM server (test fixture only)

---

## Scope

**v1 includes:**

- Time-off request lifecycle: submit, approve (HCM deduct), reject, cancel (HCM restore), list, get
- Balance management: local cache reads, defensive pre-check, optimistic-locked writes
- HCM sync inbound: real-time webhook + batch ingest with post-sync reconciliation (INVALIDATES over-budget requests)
- HCM sync outbound: deduct on approve, restore on cancel
- Audit trail: append-only `sync_log` for every balance change
- Resilience: circuit breaker, exponential retry (idempotent calls only), graceful shutdown, `/health` endpoint
- REST API versioned at `/v1/` with global `AllExceptionsFilter` and `TraceInterceptor` (UUID v4 per request)
- Mock HCM server (`test/mock-hcm/`) with configurable failure modes

**Explicitly out of scope:**

- Authentication / authorization (handled upstream by API gateway)
- Employee or location master data management (owned by HCM)
- Push notifications, UI, payroll, leave policy configuration
- Real HCM vendor adapters (Workday, SAP) — mock adapter satisfies the `IHcmAdapter` interface
- Multi-tenant isolation, pluggable HCM adapters, scheduled cron reconciliation

---

## Constraints

- **Agentic development:** No source code written manually. TRD + test suite are primary deliverables; implementation is agent-generated.
- **HCM-first dual-write:** HCM deduction is called before local DB write. A crash between steps leaves systems temporarily diverged — healed by next inbound sync.
- **Balances scoped by `(employeeId, locationId)`:** Both dimensions required on every API call, DB key, and HCM payload.
- **No retry on `deduct()`:** Deduction is non-idempotent until HCM confirms idempotency key support (B-002 in STATE.md). Retry enabled only on `restore()`.
- **Open questions:** HCM API field names (B-001) and idempotency key support (B-002) are unconfirmed; mock server uses assumed shapes.

---

## Key Docs

| Document | Path |
|----------|------|
| Technical Requirements Document | `docs/TRD.md` |
| Premises & Assumptions | `docs/PREMISES.md` |
| Project Scope | `docs/SCOPE.md` |
| Use Cases | `docs/USE_CASES.md` |
| Architecture Diagrams | `docs/ARCHITECTURE.md` |
| Data Model | `docs/DATA_MODEL.md` |
| API Specification | `docs/API_SPEC.md` |
| Test Strategy | `docs/TEST_STRATEGY.md` |
| Resilience Patterns | `docs/RESILIENCE.md` |
| Clean Code Standards | `docs/CLEAN_CODE.md` |
| Error Handling Strategy | `docs/ERROR_HANDLING.md` |
