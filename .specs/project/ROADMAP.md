# Roadmap

**Project:** ExampleHR Time-Off Microservice
**Phase:** 1 — Core implementation (this assignment)

---

## Feature Status

| # | Feature | Command | Status | Tasks file |
|---|---------|---------|--------|-----------|
| F-01 | NestJS project scaffold | — | ⬜ Not started | — |
| F-02 | Core: Balance entity + service + optimistic locking | `/implement-core` | ⬜ Not started | `.specs/features/balances/tasks.md` |
| F-03 | Core: Time-off request state machine | `/implement-core` | ⬜ Not started | `.specs/features/time-off-requests/tasks.md` |
| F-04 | HCM sync: adapter interface + HTTP client | `/implement-sync` | ⬜ Not started | `.specs/features/hcm-sync/tasks.md` |
| F-05 | HCM sync: realtime webhook + batch ingest + reconciliation | `/implement-sync` | ⬜ Not started | `.specs/features/hcm-sync/tasks.md` |
| F-06 | Resilience: circuit breaker + retry + health check + graceful shutdown | `/implement-resilience` | ⬜ Not started | `.specs/features/resilience/tasks.md` |
| F-07 | API layer: controllers + DTOs + global filter + trace interceptor | `/implement-api` | ⬜ Not started | `.specs/features/api-layer/tasks.md` |
| F-08 | Mock HCM server (test fixture) | `/implement-mock-hcm` | ⬜ Not started | — |
| F-09 | Test suite: unit + integration + E2E + resilience | `/write-tests` | ⬜ Not started | `.specs/features/test-suite/tasks.md` |

---

## Implementation Order

Features have dependencies — implement in this sequence:

```
F-01 (scaffold)
  └── F-02 (balances) ──┐
  └── F-03 (requests) ──┼── F-04/F-05 (hcm-sync) ── F-06 (resilience) ── F-07 (api) ── F-08 (mock) ── F-09 (tests)
```

F-02 and F-03 can be implemented in parallel after scaffold.
F-04 and F-05 depend on F-02 + F-03.
F-06 wraps F-04 — implement after HCM adapter exists.
F-07 requires all services to exist.
F-08 and F-09 are the final layer.

---

## Milestones

| Milestone | Features | Done when |
|-----------|----------|-----------|
| **M1 — Scaffold** | F-01 | `npm run start` boots with empty DB |
| **M2 — Core logic** | F-02, F-03 | Unit tests pass for all service methods |
| **M3 — HCM integration** | F-04, F-05 | Integration tests pass with mock HCM |
| **M4 — Production-ready** | F-06, F-07 | `/health` returns ok; all E2E tests pass |
| **M5 — Deliverable** | F-08, F-09 | Coverage ≥80%; GitHub repo ready for submission |

---

## Status Key

| Symbol | Meaning |
|--------|---------|
| ⬜ | Not started |
| 🔵 | In progress |
| ✅ | Complete |
| ⛔ | Blocked |
