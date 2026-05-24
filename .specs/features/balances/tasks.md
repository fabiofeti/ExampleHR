# F-02 Core: Balance entity + service + optimistic locking — Tasks

**Feature:** F-02 — Core: Balance entity + service + optimistic locking
**Milestone:** M2 — Unit tests pass for all service methods
**Status:** Draft
**Refs:** `docs/TRD.md`, `docs/DATA_MODEL.md`, `docs/CLEAN_CODE.md`, `docs/ERROR_HANDLING.md`, `docs/TEST_STRATEGY.md`

---

## Scope

F-02 delivers the balance persistence layer and its core business logic:

- `Balance` TypeORM entity (local HCM balance cache)
- `SyncLog` TypeORM entity + `SyncLogService.append()` (audit trail written on every balance mutation)
- Domain exceptions: `DomainException` base + `InsufficientBalanceException` + `BalanceConflictException`
- `BalancesService` with four methods:
  - `findOne(employeeId, locationId)` — fetch balance, 404 if missing
  - `defensiveCheck(balance, days)` — local pre-check before HCM call; throws `InsufficientBalanceException`
  - `deductWithLock(employeeId, locationId, days, requestId, actor)` — optimistic-lock deduction + 1 internal retry + sync log
  - `restoreWithLock(employeeId, locationId, days, requestId, actor)` — optimistic-lock restoration + 1 internal retry + sync log
- Unit tests U-B-01 to U-B-06 (service logic, all deps mocked)
- Integration tests I-03 + I-06 (real SQLite `:memory:` DB)

**Out of scope for F-02:**
- `BalancesController` / response DTOs (→ F-07)
- HCM upsert / batch insert (→ F-05)
- `TimeOffRequestsService` or any request-lifecycle logic (→ F-03)
- `HcmRejectionException`, `HcmUnavailableException`, `RequestConflictException` (→ F-03/F-04)
- Circuit breaker, retry on HCM outbound calls (→ F-06)

---

## Execution Plan

### Phase 1: Data layer + exceptions (parallel)

T1, T2, T3 have no dependencies on each other — run in parallel.

```
T1 (Balance entity)     [P]─┐
T2 (SyncLog entity+svc) [P]─┼──→ T4 (BalancesService + unit tests) ──→ T5 (integration tests)
T3 (Domain exceptions)  [P]─┘
```

### Phase 2: Service + tests (sequential)

T4 depends on T1 + T2 + T3. T5 depends on T4.

---

## Task Breakdown

---

### T1: Balance entity [P]

**What:** Create the `Balance` TypeORM entity with all columns from `docs/DATA_MODEL.md`. Wire into `BalancesModule` via `TypeOrmModule.forFeature([Balance])`.

**Where:**
- `src/balances/balance.entity.ts` — new
- `src/balances/balances.module.ts` — add `TypeOrmModule.forFeature([Balance])`

**Depends on:** None

**Entity spec:**

```typescript
@Entity('balances')
export class Balance {
  @PrimaryColumn({ name: 'employee_id' })
  employeeId: string;

  @PrimaryColumn({ name: 'location_id' })
  locationId: string;

  @Column({ type: 'float' })
  available: number;

  @Column({ type: 'float' })
  used: number;

  @Column({ type: 'float' })
  total: number;

  @Column({ type: 'int', default: 0 })
  version: number;

  @Column({ name: 'last_synced_at', type: 'datetime', nullable: true })
  lastSyncedAt: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
```

**Done when:**
- [ ] `src/balances/balance.entity.ts` exists with all 9 columns matching DATA_MODEL
- [ ] Composite PK on `(employee_id, location_id)` — two `@PrimaryColumn` decorators
- [ ] `BalancesModule` imports `TypeOrmModule.forFeature([Balance])`
- [ ] `npm run build` exits 0

**Tests:** none
**Gate:** build — `npm run build`

---

### T2: SyncLog entity + SyncLogService [P]

**What:** Create `SyncLog` TypeORM entity (append-only audit table). Create `SyncLogService` with a single `append()` method that writes one row. Export `SyncLogService` from `SyncLogModule`.

**Where:**
- `src/sync-log/sync-log.entity.ts` — new
- `src/sync-log/sync-log.service.ts` — new
- `src/sync-log/sync-log.module.ts` — update

**Depends on:** None

**Entity spec:**

```typescript
export enum SyncSource {
  REALTIME_WEBHOOK = 'realtime_webhook',
  BATCH = 'batch',
  REQUEST_APPROVE = 'request_approve',
  REQUEST_CANCEL = 'request_cancel',
  INVALIDATION = 'invalidation',
}

@Entity('sync_log')
export class SyncLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'employee_id' })
  employeeId: string;

  @Column({ name: 'location_id' })
  locationId: string;

  @Column({ type: 'varchar', enum: SyncSource })
  source: SyncSource;

  @Column({ name: 'previous_available', type: 'float' })
  previousAvailable: number;

  @Column({ name: 'new_available', type: 'float' })
  newAvailable: number;

  @Column()
  actor: string;

  @Column({ name: 'request_id', nullable: true })
  requestId: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
```

**SyncLogService.append() signature:**

```typescript
append(params: {
  employeeId: string;
  locationId: string;
  source: SyncSource;
  previousAvailable: number;
  newAvailable: number;
  actor: string;
  requestId: string | null;
}): Promise<void>
```

**SyncLogModule:** register `TypeOrmModule.forFeature([SyncLog])`, provide and **export** `SyncLogService`.

**Done when:**
- [ ] `src/sync-log/sync-log.entity.ts` exists with all 9 columns matching DATA_MODEL
- [ ] `SyncSource` enum has all 5 string values
- [ ] `src/sync-log/sync-log.service.ts` exists with `append()` that inserts one row
- [ ] `SyncLogModule` exports `SyncLogService`
- [ ] `npm run build` exits 0

**Tests:** none (behavior verified via I-06 in T5)
**Gate:** build — `npm run build`

---

### T3: Domain exceptions [P]

**What:** Create the exception hierarchy per `docs/CLEAN_CODE.md` section 5 and `docs/ERROR_HANDLING.md`. F-02 needs `DomainException`, `InsufficientBalanceException`, and `BalanceConflictException`. The remaining exceptions (`HcmRejectionException`, `HcmUnavailableException`, `RequestConflictException`) will be created in F-03/F-04 but the base class must exist now.

**Where:**
- `src/common/exceptions/domain.exception.ts` — new
- `src/common/exceptions/insufficient-balance.exception.ts` — new
- `src/common/exceptions/balance-conflict.exception.ts` — new
- `src/common/exceptions/index.ts` — barrel export (new)

**Depends on:** None

**Exception shapes (from CLEAN_CODE.md section 5 + ERROR_HANDLING.md section 6):**

```typescript
// domain.exception.ts
export class DomainException extends HttpException {
  constructor(public readonly code: string, message: string, status: number) {
    super({ statusCode: status, error: code, message }, status);
  }
}

// insufficient-balance.exception.ts
// message: "Available balance (3.0) is less than requested days (5.0)"
// code: INSUFFICIENT_BALANCE, HTTP 422
export class InsufficientBalanceException extends DomainException { ... }

// balance-conflict.exception.ts
// message: "Balance was modified concurrently. Please retry."
// code: CONFLICT, HTTP 409
export class BalanceConflictException extends DomainException { ... }
```

**Done when:**
- [ ] `DomainException` extends `HttpException`, constructor accepts `(code, message, status)`
- [ ] `InsufficientBalanceException(available, requested)` produces the exact message format from ERROR_HANDLING.md
- [ ] `BalanceConflictException()` produces the exact message from ERROR_HANDLING.md
- [ ] `src/common/exceptions/index.ts` barrel-exports all three
- [ ] `npm run build` exits 0

**Tests:** none (exception shape verified via unit test assertions in T4)
**Gate:** build — `npm run build`

---

### T4: BalancesService + unit tests U-B-01 to U-B-06

**What:** Write unit tests first (RED), then implement `BalancesService` to make them pass (GREEN). Wire `BalancesModule` to export `BalancesService` and import `SyncLogModule`.

**Where:**
- `test/unit/balances.service.spec.ts` — new (write FIRST — RED phase)
- `src/balances/balances.service.ts` — new (implement after tests exist)
- `src/balances/balances.module.ts` — update: add `BalancesService` provider, import `SyncLogModule`, export `BalancesService`

**Depends on:** T1, T2, T3

**BalancesService public API:**

```typescript
findOne(employeeId: string, locationId: string): Promise<Balance>
// throws NotFoundException if no record

defensiveCheck(balance: Balance, days: number): void
// throws InsufficientBalanceException if balance.available < days
// returns void (no-op) if balance.available >= days

deductWithLock(
  employeeId: string,
  locationId: string,
  days: number,
  requestId: string,
  actor: string,
): Promise<void>
// 1. Fetches fresh balance via findOne
// 2. Issues UPDATE ... WHERE version = :v (increments version, decrements available, increments used)
// 3. If 0 rows affected: retries ONCE with a freshly-fetched balance
// 4. If second attempt also fails: throws BalanceConflictException
// 5. On success: calls SyncLogService.append with source REQUEST_APPROVE

restoreWithLock(
  employeeId: string,
  locationId: string,
  days: number,
  requestId: string,
  actor: string,
): Promise<void>
// Mirror of deductWithLock but increments available, decrements used
// Calls SyncLogService.append with source REQUEST_CANCEL
```

**Implementation notes:**
- Optimistic lock UPDATE template (deduct):
  ```sql
  UPDATE balances
  SET available = available - :days,
      used      = used      + :days,
      version   = version   + 1,
      updated_at = CURRENT_TIMESTAMP
  WHERE employee_id = :eid AND location_id = :lid AND version = :v
  ```
- Check `result.affected === 0` for version mismatch detection
- `findOne` uses TypeORM Repository; inject via `@InjectRepository(Balance)`
- `SyncLogService` injected via constructor (standard NestJS injection)
- No `process.env` access; no `ConfigService` needed at this layer

**Unit test setup (mocking strategy):**

All dependencies are mocked:
- `Repository<Balance>` → mock with `jest.fn()` on `.findOne()` and `.query()` / raw query via `DataSource`
- `SyncLogService` → mock with `jest.fn()` on `.append()`

Tests live in `test/unit/balances.service.spec.ts`.

**Test cases (all 6 must be RED before implementation begins):**

| ID | Scenario | Setup | Expected |
|----|----------|-------|----------|
| U-B-01 | `available === days` | balance.available = 5, days = 5 | `defensiveCheck` does not throw |
| U-B-02 | `available < days` | balance.available = 3, days = 5 | throws `InsufficientBalanceException`; message includes "3" and "5" |
| U-B-03 | `available > days` | balance.available = 10, days = 3 | `defensiveCheck` does not throw |
| U-B-04 | Balance record not found | `findOne` returns null | throws `NotFoundException` |
| U-B-05 | Version mismatch on both attempts | mock UPDATE returns `{affected:0}` twice | throws `BalanceConflictException` |
| U-B-06 | Version mismatch on first attempt, success on second | mock UPDATE returns `{affected:0}` then `{affected:1}` | resolves without throwing; `syncLog.append` called once |

**Done when:**
- [ ] All 6 unit tests exist and are confirmed FAILING before implementation
- [ ] `BalancesService` implements all 4 methods
- [ ] All 6 unit tests pass
- [ ] `BalancesModule` providers: `BalancesService`; imports: `TypeOrmModule.forFeature([Balance])`, `SyncLogModule`; exports: `BalancesService`
- [ ] `npm run test -- --testPathPattern=balances.service.spec` exits 0, 6 tests pass

**Tests:** U-B-01, U-B-02, U-B-03, U-B-04, U-B-05, U-B-06
**Gate:** quick — `npm run test -- --testPathPattern=balances.service.spec`

---

### T5: Integration tests I-03 and I-06

**What:** Write integration tests against a real SQLite `:memory:` database. These tests spin up a NestJS testing module with TypeORM + real repositories but mock HCM. Verifies that the SQL and ORM configuration are correct (things unit mocks cannot catch).

**Where:**
- `test/integration/balances.integration.spec.ts` — new

**Depends on:** T4

**Test module setup pattern:**

```typescript
const module = await Test.createTestingModule({
  imports: [
    TypeOrmModule.forRoot({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Balance, SyncLog],
      synchronize: true,
    }),
    TypeOrmModule.forFeature([Balance, SyncLog]),
  ],
  providers: [BalancesService, SyncLogService],
}).compile();
```

**Test cases:**

| ID | Scenario | Setup | Expected |
|----|----------|-------|----------|
| I-03 | Concurrent version conflict on balance write | Seed one balance row with version=0; manually UPDATE to set version=1 between the deductWithLock fetch and its UPDATE (simulate with two sequential calls with stale balance data) | Second `deductWithLock` call (with stale version) fails with `BalanceConflictException` |
| I-06 | Sync log delta matches request.days after deduction | Seed balance with available=10; call `deductWithLock` for days=3 | `sync_log` has exactly 1 row with `previous_available=10`, `new_available=7`, `source=request_approve` |

**Implementation note for I-03:** To test the conflict scenario, set up the service with a custom repository mock that:
1. First call to `findOne` returns balance with version=0
2. The internal UPDATE simulates a concurrent write by having the actual DB already at version=1

OR: use two concurrent `deductWithLock` calls on the same balance — the first to complete wins; the second hits the version mismatch and should retry once (but the retry also sees the wrong version) → throws.

**Done when:**
- [ ] `test/integration/balances.integration.spec.ts` exists with I-03 and I-06
- [ ] I-03: confirms `BalanceConflictException` on version mismatch with real SQLite
- [ ] I-06: confirms sync log row has correct delta values
- [ ] `npm run test -- --testPathPattern=balances.integration.spec` exits 0, 2 tests pass
- [ ] `npm run build` exits 0

**Tests:** I-03, I-06
**Gate:** full — `npm run test -- --testPathPattern=balances.integration.spec`

---

## Parallel Execution Map

```
Phase 1 (Parallel — all three start immediately):
  T1 (Balance entity)      [P]
  T2 (SyncLog entity+svc)  [P]
  T3 (Domain exceptions)   [P]

Phase 2 (Sequential — after all Phase 1 tasks complete):
  T1 + T2 + T3 ──→ T4 (BalancesService + unit tests)
                            ──→ T5 (integration tests)
```

**Note:** T1, T2, T3 touch different files entirely — no merge conflicts possible.

---

## Validation Report

### Check 1: Task Granularity

| Task | Scope | Status |
|------|-------|--------|
| T1: Balance entity | 1 entity file + 1 module update | ✅ Granular |
| T2: SyncLog entity + service | 2 new files + 1 module update | ✅ Granular (cohesive pair — entity must exist before service) |
| T3: Domain exceptions | 3 small files + 1 barrel | ✅ Granular |
| T4: BalancesService + unit tests | 1 service file + 1 test file + 1 module update | ✅ Granular |
| T5: Integration tests | 1 test file | ✅ Granular |

### Check 2: Diagram-Definition Cross-Check

| Task | Depends On (body) | Diagram Shows | Status |
|------|-------------------|---------------|--------|
| T1 | None | Start [P] | ✅ Match |
| T2 | None | Start [P] | ✅ Match |
| T3 | None | Start [P] | ✅ Match |
| T4 | T1, T2, T3 | T1+T2+T3 → T4 | ✅ Match |
| T5 | T4 | T4 → T5 | ✅ Match |

No parallel tasks depend on each other. ✅

### Check 3: Test Co-location Validation

Source: `docs/TEST_STRATEGY.md`

| Task | Code Layer | TEST_STRATEGY Requires | Task Says | Status |
|------|-----------|------------------------|-----------|--------|
| T1: Balance entity | Entity (no logic) | None — entity-only | none | ✅ OK |
| T2: SyncLog entity + service | Append-only write (trivial logic) | None directly; behavior verified via I-06 | none (→ T5) | ✅ OK |
| T3: Domain exceptions | Value objects (no logic) | None | none | ✅ OK |
| T4: BalancesService | Service — business logic | U-B-01 to U-B-06 (unit) | U-B-01..06 | ✅ Match |
| T5: Integration tests | Service + real DB | I-03, I-06 (integration) | I-03, I-06 | ✅ Match |

All test assignments match TEST_STRATEGY.md. ✅

### Check 4: CLEAN_CODE Compliance

| Rule | Where enforced |
|------|---------------|
| Module = bounded context | T1: Balance in balances/, T2: SyncLog in sync-log/ |
| Module exports only its Service | T2: SyncLogModule exports SyncLogService, not SyncLog entity |
| No cross-module entity access | BalancesService calls SyncLogService.append(), never writes to sync_log directly |
| Exception hierarchy from DomainException | T3: all exceptions extend DomainException |
| No `any` | TypeScript strict mode (already enabled in F-01) |
| Enum string values | T2: SyncSource uses string enum values |

---

## Pre-execution Note

Before running T4, confirm that `feat/fist-steps` scaffold code (F-01) is merged or available on the current branch. F-02 requires:
- `src/` directory with module stubs from F-01
- `package.json` with all deps installed (TypeORM, better-sqlite3, etc.)
- TypeORM configured in `AppModule`

If on a branch without F-01, merge or rebase from `feat/fist-steps` first.
