# Handoff

**Date:** 2026-05-24T00:00:00Z
**Feature:** F-08 — Mock HCM server (test fixture)
**Task:** All tasks complete — F-08 fully delivered ✅

---

## Completed ✓

- **F-01 through F-07 (prior sessions)** — all complete; M1–M4 milestones delivered.

- **F-08 — Mock HCM server (this session):**
  - `test/mock-hcm/state.ts` — purely in-memory balance store (`Map<key, MockBalance>`), mode enum, append-only call log; `reset()` wipes all state
  - `test/mock-hcm/server.ts` — Express app; all endpoints wired; mode auto-resets to `normal` after a one-shot mode fires; `timeout-next` sleeps 10s before responding; `reject-next` returns 422 without `code` field (maps to `HcmRejectionException` in adapter); `error-next` returns 500; `accept-all` skips balance check; `normal` returns `code: 'INSUFFICIENT_BALANCE'` on shortfall; all deduct/restore calls appended to call log; `POST /mock/push-realtime|push-batch` proxies to ExampleHR `/v1/hcm/sync/*`; `GET /health` for ping check
  - `test/mock-hcm/index.ts` — `startMockHcm(examplehrBaseUrl, port?)` / `stopMockHcm()` async helpers for `beforeAll`/`afterAll`; re-exports `setBalance`, `setMode`, `getCallLog` for test ergonomics
  - Committed: `92ee479` on `feat/Tasks-08` (pushed to remote)

- **Test counts (unchanged from F-07):** 50 total — all pass ✅
- **`npm run build`** exits 0 ✅
- **`npx tsc --noEmit`** exits 0 ✅

### Key implementation details

- `noUncheckedIndexedAccess: true` in tsconfig — route params typed as `Request<{ employeeId: string; locationId: string }>` to avoid `string | undefined` from `req.params`
- Express is a transitive dependency (not in `dependencies`) — available at runtime; `@types/express` is in devDependencies
- Mock server port default: `4001`. ExampleHR base URL passed as first arg to `startMockHcm()`.
- Deduct logs the call BEFORE applying mode logic — so `reject-next` and `error-next` still appear in the call log (for circuit-breaker count assertions)
- `stopMockHcm()` safely resolves if server was never started

---

## In Progress

Nothing — session ended cleanly after F-08 completion and push.

---

## Pending

1. **F-09 — Full test suite: unit + integration + E2E + resilience**
   - Unit tests: all U-B-*, U-R-*, U-S-* cases from TEST_STRATEGY.md
   - Integration tests: I-01..I-06
   - E2E tests: E-01..E-11 (Supertest + embedded mock HCM server)
   - Resilience tests: R-01..R-08
   - Coverage target: ≥80% overall, ≥90% branch on service files
   - Use `/write-tests` command

---

## Blockers

- **B-001** — HCM API field names unconfirmed. Workaround: mock-hcm uses assumed shapes.
- **B-002** — HCM idempotency key not confirmed. Deduct retry disabled per AD-009.

---

## Context

- F-08 completes the last prerequisite for M5
- M5 (deliverable) needs only F-09: full test suite with coverage ≥80%
- Branch `feat/Tasks-08` is open on GitHub — consider merging before starting F-09 or continuing on same branch
- Mock server is designed to be used from E2E tests via `startMockHcm('http://localhost:3000', 4001)` — ExampleHR must be started first on port 3000, then mock on 4001
- API versioning: all routes under `/v1/`; mock push endpoints target `/v1/hcm/sync/realtime` and `/v1/hcm/sync/batch`
