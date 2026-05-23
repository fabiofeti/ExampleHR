# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Summary

ExampleHR Time-Off Microservice — a NestJS + SQLite backend that manages the full lifecycle of employee time-off requests while keeping balances synchronized with an external Human Capital Management (HCM) system (e.g., Workday, SAP). The HCM is the source of truth; this service is the request interface.

## Tech Stack

- **Runtime:** Node.js (TypeScript)
- **Framework:** NestJS
- **Database:** SQLite via TypeORM
- **Testing:** Jest + Supertest
- **Mock HCM server:** Express (embedded in test suite)

## Commands

```bash
# Install dependencies
npm install

# Run the application
npm run start

# Run in watch/dev mode
npm run start:dev

# Build for production
npm run build

# Lint
npm run lint

# Run all tests
npm run test

# Run tests with coverage
npm run test:cov

# Run a single test file
npm run test -- --testPathPattern=time-off-requests.service

# Run e2e tests
npm run test:e2e
```

## Architecture Overview

The service has three primary responsibilities:

1. **Request Lifecycle** — Employees submit requests; managers approve/reject/cancel. All state transitions go through `TimeOffRequestsService` which enforces the state machine and delegates balance operations.

2. **Balance Management** — `BalancesService` maintains a local cache of `(employeeId, locationId)` balances. Before any deduction it performs a defensive local check, then calls the HCM real-time API. If HCM rejects, the local state is not modified. Optimistic locking (`version` column) guards concurrent updates.

3. **HCM Sync** — `HcmSyncService` handles two inbound paths:
   - **Real-time webhook** (`POST /hcm/sync/realtime`): single balance update pushed by HCM (e.g., work anniversary bonus).
   - **Batch ingest** (`POST /hcm/sync/batch`): full balance dump from HCM; upserts all rows and reconciles any in-flight requests whose balance assumptions may now be invalid.

### Module boundaries

```
src/
  balances/          # Balance entity, BalancesService, BalancesController
  time-off-requests/ # Request entity, RequestsService, RequestsController
  hcm-sync/          # HcmSyncService, HcmSyncController, HcmAdapterService
  sync-log/          # SyncLog entity for audit trail
  common/            # Guards, interceptors, DTOs shared across modules
  app.module.ts
  main.ts
test/
  unit/              # Jest unit tests for service-layer logic
  integration/       # TypeORM + SQLite in-memory DB tests
  e2e/               # Supertest + embedded mock HCM server
  mock-hcm/          # Express mock HCM server with configurable balance state
```

### Key design decisions

- **Defensive local check before every HCM call** — even though HCM is authoritative, we reject locally if `balance.available < requested` to avoid unnecessary round-trips and to handle HCM outages gracefully.
- **Optimistic locking on `balances`** — prevents a batch sync and a concurrent request approval from corrupting the same balance row.
- **Idempotent batch ingest** — HCM batch endpoint upserts by `(employeeId, locationId)`; re-running the same payload is safe.
- **Sync log** — every balance change (source: `realtime | batch | request`) is appended to `sync_log` for auditability and divergence debugging.
- **Circuit breaker on HCM** — `opossum` wraps all `HcmAdapterService` outbound calls; opens at 50% error rate over 10 calls; auto-recovers after 30s.
- **Health endpoint at `/health`** — DB + HCM checks; returns `ok` / `degraded` (HCM down, reads still work) / `down` (DB down).
- **Dependency inversion for HCM** — services inject `IHcmAdapter` token, never the concrete class; enables clean mocking in all test layers.

## Token Economy — Use Scoped Commands

**Do not load all docs every session.** Each slash command loads only the docs its task needs. This keeps context lean and generation accurate.

| Task | Command | Docs loaded |
|------|---------|-------------|
| Implement core business logic | `/implement-core` | TRD, DATA_MODEL, CLEAN_CODE, ERROR_HANDLING, PREMISES |
| Implement HCM sync + adapter | `/implement-sync` | TRD, ARCHITECTURE, RESILIENCE, CLEAN_CODE, ERROR_HANDLING |
| Implement controllers + DTOs | `/implement-api` | API_SPEC, USE_CASES, CLEAN_CODE, ERROR_HANDLING |
| Implement circuit breaker + health | `/implement-resilience` | RESILIENCE, ARCHITECTURE, ERROR_HANDLING, CLEAN_CODE |
| Implement mock HCM server | `/implement-mock-hcm` | TEST_STRATEGY, API_SPEC, RESILIENCE |
| Write tests | `/write-tests` | TEST_STRATEGY, USE_CASES, API_SPEC, RESILIENCE |
| Review implementation vs. spec | `/review-design` | TRD, PREMISES, SCOPE, ARCHITECTURE |

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
| **Resilience Patterns** | `docs/RESILIENCE.md` |
| **Clean Code Standards** | `docs/CLEAN_CODE.md` |
| **Error Handling Strategy** | `docs/ERROR_HANDLING.md` |

## Testing Philosophy

This project uses **agentic development** — the TRD and tests are the primary artifacts. Code is generated from them, not the other way around. When adding a feature:

1. Update the relevant doc first.
2. Write or update the test(s) that describe the desired behavior.
3. Let the agent generate the implementation to make the tests pass.

Test layers:
- **Unit** — service business logic in isolation (mock all dependencies).
- **Integration** — service + real SQLite in-memory DB (no mocks for DB layer).
- **E2E** — full HTTP stack with embedded mock HCM server; covers happy paths, HCM errors, and race conditions (concurrent requests against same balance).
