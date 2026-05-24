# Handoff

**Date:** 2026-05-24T00:00:00Z
**Feature:** F-02 — Core: Balance entity + service + optimistic locking
**Task:** All 5 tasks complete — F-02 fully delivered ✅

---

## Completed ✓

- F-01 NestJS scaffold (merged from `feat/fist-steps` into `feat/Tasks-f02`)
- **F-02 — all 5 tasks:**
  - T1: `Balance` entity (`src/balances/balance.entity.ts`) + `BalancesModule` wired
  - T2: `SyncLog` entity + `SyncSource` enum + `SyncLogService.append()` (`src/sync-log/`)
  - T3: `DomainException` base + `InsufficientBalanceException` + `BalanceConflictException` (`src/common/exceptions/`)
  - T4: `BalancesService` — `findOne`, `defensiveCheck`, `deductWithLock`, `restoreWithLock` (optimistic lock + 1 retry) + unit tests U-B-01..06 (`test/unit/balances.service.spec.ts`)
  - T5: Integration tests I-03 (concurrent conflict) + I-06 (sync log delta) (`test/integration/balances.integration.spec.ts`)
- 9 tests passing (6 unit + 3 integration)
- `npm run build` exits 0

---

## In Progress

Nothing — session ended cleanly after F-02 completion.

---

## Pending

1. **`break into tasks` for F-03** — Core: Time-off request state machine
   - Entities: `TimeOffRequest` entity with `RequestStatus` enum
   - Service: `TimeOffRequestsService` — `submit`, `approve`, `reject`, `cancel`
   - Approval flow: defensiveCheck → HCM deduct → `deductWithLock` (in single DB transaction)
   - Overlap detection query (409 on overlapping PENDING/APPROVED requests)
   - Unit tests U-R-01..10 + integration tests I-01, I-02
2. After F-03: F-04/F-05 (HCM sync adapter + webhooks) in sequence

---

## Blockers

- **B-001** — HCM API field names unconfirmed. No impact on F-03 (F-03 injects `IHcmAdapter` interface, not the concrete class).
- **B-002** — HCM idempotency key unconfirmed. No impact on F-03 (deduct retry disabled per AD-009).

---

## Context

- Branch: `feat/Tasks-f02`
- Uncommitted: none — all committed
- `feat/fist-steps` (F-01) already merged into current branch
- Related decisions: AD-001 (HCM-first), AD-003 (defensive check), AD-004 (optimistic locking), AD-008 (IHcmAdapter DI), AD-009 (no deduct retry)
- Next feature order per ROADMAP: F-03 → F-04 → F-05 → F-06 → F-07 → F-08 → F-09
