# F-03 Core: Time-off request state machine — Tasks

**Feature:** F-03 — Core: Time-off request state machine
**Milestone:** M2 — Unit tests pass for all service methods
**Status:** Done ✅
**Refs:** `docs/TRD.md`, `docs/DATA_MODEL.md`, `docs/USE_CASES.md`, `docs/CLEAN_CODE.md`, `docs/ERROR_HANDLING.md`, `docs/TEST_STRATEGY.md`

---

## Scope

F-03 delivers the time-off request lifecycle state machine and the prerequisite building blocks it depends on:

- `TimeOffRequest` TypeORM entity with `RequestStatus` enum
- New domain exceptions: `HcmRejectionException`, `HcmUnavailableException`, `RequestConflictException`
- `IHcmAdapter` interface + `HCM_ADAPTER_TOKEN` constant (port definition — concrete HTTP client is F-04)
- `BalancesService` extended with optional `EntityManager` parameter on `deductWithLock` + `restoreWithLock` (enables F-03's single-transaction approval/cancel flow)
- `TimeOffRequestsService` with five methods: `submit`, `findOne`, `approve`, `reject`, `cancel`
- Unit tests U-R-01..U-R-10
- Integration tests I-01 + I-02 (overlap detection with real SQLite)

**Out of scope for F-03:**
- `TimeOffRequestsController` / response DTOs (→ F-07)
- Concrete `HcmAdapterService` HTTP implementation (→ F-04)
- HCM sync webhooks and batch ingest (→ F-05)
- Circuit breaker and retry logic (→ F-06)
- E2E tests (→ F-09)

---

## Key Design Decisions

### Transactional approval and cancel flows

Per TRD §3.2 (C1 solution): after HCM deduction succeeds, the local balance update and request status change must happen in a **single SQLite transaction** to prevent the partial-write window.

`TimeOffRequestsService.approve()` injects `DataSource` and wraps steps 3-4 in `dataSource.transaction()`:

```
1. findOne(id) → verify PENDING
2. defensiveCheck(balance, days)
3. hcmAdapter.deduct(...)          ← outside transaction (HCM-first)
4. dataSource.transaction(manager => {
     balancesService.deductWithLock(..., manager)
     manager.save(TimeOffRequest, { status: APPROVED })
   })
```

To support step 4, `BalancesService.deductWithLock` and `restoreWithLock` accept an optional `EntityManager`. When provided, they use `manager.createQueryBuilder()` instead of `this.repo.createQueryBuilder()`.

### Overlap detection query

`submit()` checks for PENDING/APPROVED requests with overlapping date ranges. Two requests overlap when:

```sql
start_date < :endDate AND end_date > :startDate
```

Strict inequalities ensure that `end_date_A == start_date_B` is **not** treated as an overlap (I-02 requirement: adjacent requests are allowed).

### IHcmAdapter interface location

The port file lives in `src/hcm-sync/ports/` per CLEAN_CODE.md §3. For F-03, `TimeOffRequestsModule` does **not** import `HcmSyncModule` — unit and integration tests provide a mock via `{ provide: HCM_ADAPTER_TOKEN, useValue: mockAdapter }`. Full wiring through `AppModule` happens in F-04.

---

## Execution Plan

### Phase 1: Foundation (All 4 tasks in parallel)

T1, T2, T3, T4 touch completely different files — no merge conflicts possible.

```
T1 (TimeOffRequest entity)   [P] ─┐
T2 (New exceptions)          [P] ─┤
T3 (IHcmAdapter port)        [P] ─┼──→ T5 (TimeOffRequestsService + unit tests) ──→ T6 (integration tests)
T4 (BalancesService extend)  [P] ─┘
```

### Phase 2: Service + unit tests (sequential)

T5 depends on T1 + T2 + T3 + T4.

### Phase 3: Integration tests (sequential)

T6 depends on T5.

---

## Task Breakdown

---

### T1: TimeOffRequest entity + RequestStatus enum [P]

**What:** Create `TimeOffRequest` TypeORM entity with all columns from `docs/DATA_MODEL.md`. Define `RequestStatus` enum. Wire into `TimeOffRequestsModule` via `TypeOrmModule.forFeature([TimeOffRequest])`.

**Where:**
- `src/time-off-requests/time-off-request.entity.ts` — new
- `src/time-off-requests/time-off-requests.module.ts` — add `TypeOrmModule.forFeature([TimeOffRequest])`

**Depends on:** None
**Requirement:** DATA_MODEL.md `time_off_requests` table

**Entity spec:**

```typescript
export enum RequestStatus {
  PENDING     = 'PENDING',
  APPROVED    = 'APPROVED',
  REJECTED    = 'REJECTED',
  CANCELLED   = 'CANCELLED',
  INVALIDATED = 'INVALIDATED',
}

@Entity('time_off_requests')
export class TimeOffRequest {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'employee_id' })
  employeeId: string;

  @Column({ name: 'location_id' })
  locationId: string;

  @Column({ name: 'leave_type' })
  leaveType: string;

  @Column({ name: 'start_date', type: 'date' })
  startDate: string;       // stored as ISO date string 'YYYY-MM-DD'

  @Column({ name: 'end_date', type: 'date' })
  endDate: string;

  @Column({ type: 'float' })
  days: number;

  @Column({ type: 'varchar' })
  status: RequestStatus;

  @Column({ name: 'rejection_reason', nullable: true, type: 'varchar' })
  rejectionReason: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
```

**Indexes to add** (DATA_MODEL.md SQLite Notes):

```typescript
@Index(['employeeId', 'locationId', 'status'])
@Index(['startDate', 'endDate'])
```

**Done when:**
- [ ] `src/time-off-requests/time-off-request.entity.ts` exists with all columns matching DATA_MODEL
- [ ] `RequestStatus` enum has all 5 string values
- [ ] Both indexes declared
- [ ] `TimeOffRequestsModule` imports `TypeOrmModule.forFeature([TimeOffRequest])`
- [ ] `npm run build` exits 0

**Tests:** none
**Gate:** build — `npm run build`

---

### T2: New domain exceptions [P]

**What:** Create the three domain exceptions needed by F-03 that were deferred from F-02. Update the barrel export.

**Where:**
- `src/common/exceptions/hcm-rejection.exception.ts` — new
- `src/common/exceptions/hcm-unavailable.exception.ts` — new
- `src/common/exceptions/request-conflict.exception.ts` — new
- `src/common/exceptions/index.ts` — add 3 new exports

**Depends on:** T3 of F-02 (DomainException base already exists)
**Requirement:** CLEAN_CODE.md §5, ERROR_HANDLING.md §6

**Exception specs:**

```typescript
// hcm-rejection.exception.ts
// code: HCM_REJECTION, HTTP 422
// message: "HCM rejected the operation: <reason>"
export class HcmRejectionException extends DomainException {
  constructor(reason: string) {
    super('HCM_REJECTION', `HCM rejected the operation: ${reason}`, 422);
  }
}

// hcm-unavailable.exception.ts
// code: HCM_UNAVAILABLE, HTTP 503
// message: "HCM did not respond within the timeout period. traceId: <id>"
export class HcmUnavailableException extends DomainException {
  constructor(traceId: string) {
    super('HCM_UNAVAILABLE', `HCM did not respond within the timeout period. traceId: ${traceId}`, 503);
  }
}

// request-conflict.exception.ts
// code: CONFLICT, HTTP 409
// message: "Request is not in PENDING status (current: APPROVED)"
export class RequestConflictException extends DomainException {
  constructor(currentStatus: RequestStatus) {
    super('CONFLICT', `Request is not in an actionable status (current: ${currentStatus})`, 409);
  }
}
```

**Done when:**
- [ ] All 3 exception files exist with correct codes, HTTP statuses, and message formats matching ERROR_HANDLING.md §6
- [ ] `index.ts` barrel exports all 6 exceptions (3 existing + 3 new)
- [ ] `npm run build` exits 0

**Tests:** none (shapes verified by unit test assertions in T5)
**Gate:** build — `npm run build`

---

### T3: IHcmAdapter interface + HCM_ADAPTER_TOKEN [P]

**What:** Create the HCM adapter port file defining the `IHcmAdapter` interface, `HcmBalanceResponse` type, and `HCM_ADAPTER_TOKEN` injection constant. This is a pure interface definition — no runtime implementation (concrete adapter is F-04).

**Where:**
- `src/hcm-sync/ports/hcm-adapter.port.ts` — new (directory `ports/` must be created)

**Depends on:** None
**Requirement:** CLEAN_CODE.md §3

**Port spec:**

```typescript
export interface HcmBalanceResponse {
  employeeId: string;
  locationId: string;
  available: number;
  used: number;
  total: number;
}

export interface IHcmAdapter {
  deduct(
    employeeId: string,
    locationId: string,
    days: number,
    idempotencyKey: string,
  ): Promise<HcmBalanceResponse>;

  restore(
    employeeId: string,
    locationId: string,
    days: number,
    idempotencyKey: string,
  ): Promise<HcmBalanceResponse>;

  ping(): Promise<boolean>;
}

export const HCM_ADAPTER_TOKEN = 'HCM_ADAPTER_TOKEN';
```

**Done when:**
- [ ] `src/hcm-sync/ports/hcm-adapter.port.ts` exists with `IHcmAdapter`, `HcmBalanceResponse`, and `HCM_ADAPTER_TOKEN`
- [ ] Interface includes `deduct`, `restore`, and `ping` methods with the exact signatures above
- [ ] `npm run build` exits 0

**Tests:** none
**Gate:** build — `npm run build`

---

### T4: Extend BalancesService for transaction sharing [P]

**What:** Modify `BalancesService.deductWithLock` and `restoreWithLock` to accept an optional `EntityManager` parameter. When provided, all queries run through the manager (enabling the caller to wrap them in a `DataSource.transaction()`). Backward-compatible: callers without a manager continue to use `this.repo`.

**Where:**
- `src/balances/balances.service.ts` — modify `deductWithLock`, `restoreWithLock`, and `tryUpdate`
- `test/unit/balances.service.spec.ts` — add U-B-07 for the EntityManager path

**Depends on:** F-02 T4 (BalancesService exists)

**Signature changes:**

```typescript
async deductWithLock(
  employeeId: string,
  locationId: string,
  days: number,
  requestId: string,
  actor: string,
  manager?: EntityManager,   // ← NEW optional param
): Promise<void>

async restoreWithLock(
  employeeId: string,
  locationId: string,
  days: number,
  requestId: string,
  actor: string,
  manager?: EntityManager,   // ← NEW optional param
): Promise<void>

// private helper:
private async tryUpdate(
  balance: Balance,
  days: number,
  operation: 'deduct' | 'restore',
  manager?: EntityManager,   // ← pass through from above
): Promise<boolean>
```

**Implementation pattern for `tryUpdate`:**

```typescript
const qb = manager
  ? manager.createQueryBuilder().update(Balance)
  : this.repo.createQueryBuilder().update(Balance);

const result = await qb
  .set({ ... })
  .where('employee_id = :eid AND location_id = :lid AND version = :v', { ... })
  .execute();
```

Similarly, `findOne` when called inside `deductWithLock` should use `manager?.getRepository(Balance).findOneBy(...)` if a manager is provided.

**Unit test U-B-07:**

| ID | Scenario | Setup | Expected |
|----|----------|-------|----------|
| U-B-07 | `deductWithLock` with provided EntityManager | Mock EntityManager's `createQueryBuilder` chain to return `{affected:1}`; mock `getRepository(Balance).findOneBy()` to return a balance | `tryUpdate` uses the manager's queryBuilder; `syncLogService.append` called once |

**Done when:**
- [ ] `deductWithLock` and `restoreWithLock` signatures include optional `manager?: EntityManager`
- [ ] `tryUpdate` routes through manager when provided
- [ ] `findOne` within the lock methods uses manager when provided
- [ ] All existing 6 unit tests (U-B-01..U-B-06) still pass unmodified
- [ ] U-B-07 added and passes
- [ ] `npm run test -- --testPathPattern=balances.service.spec` exits 0, **7 tests pass**
- [ ] `npm run build` exits 0

**Tests:** unit (U-B-07)
**Gate:** quick — `npm run test -- --testPathPattern=balances.service.spec`

---

### T5: TimeOffRequestsService + unit tests U-R-01..U-R-10

**What:** Write unit tests first (RED), then implement `TimeOffRequestsService` to make them pass (GREEN). Wire `TimeOffRequestsModule` to provide and export `TimeOffRequestsService`.

**Where:**
- `test/unit/time-off-requests.service.spec.ts` — new (write FIRST — RED phase)
- `src/time-off-requests/time-off-requests.service.ts` — new (implement after tests exist)
- `src/time-off-requests/time-off-requests.module.ts` — update: providers, imports, exports

**Depends on:** T1, T2, T3, T4

**TimeOffRequestsService public API:**

```typescript
submit(dto: {
  employeeId: string;
  locationId: string;
  leaveType: string;
  startDate: string;   // 'YYYY-MM-DD'
  endDate: string;
  days: number;
}): Promise<TimeOffRequest>
// 1. balancesService.findOne(eid, lid)   ← NotFoundException if no balance record
// 2. balancesService.defensiveCheck(balance, days)  ← InsufficientBalanceException if low
// 3. Overlap query: SELECT 1 FROM time_off_requests WHERE employee_id = :eid
//    AND location_id = :lid AND status IN ('PENDING','APPROVED')
//    AND start_date < :endDate AND end_date > :startDate
//    → throws RequestConflictException(RequestStatus.PENDING) if any row found
// 4. requestRepo.save({ ...dto, status: PENDING })
// Returns: saved TimeOffRequest

findOne(id: string): Promise<TimeOffRequest>
// throws NotFoundException if not found

approve(id: string, traceId: string): Promise<TimeOffRequest>
// 1. findOne(id)
// 2. if status !== PENDING → throw RequestConflictException(status)
// 3. balancesService.findOne(eid, lid)
// 4. balancesService.defensiveCheck(balance, days)
// 5. await hcmAdapter.deduct(eid, lid, days, id)
//    → HcmRejectionException on 4xx HCM error
//    → HcmUnavailableException on timeout/5xx
// 6. await dataSource.transaction(async manager => {
//      await balancesService.deductWithLock(eid, lid, days, id, traceId, manager)
//      await manager.save(TimeOffRequest, { ...request, status: APPROVED })
//    })
// Returns: approved TimeOffRequest

reject(id: string, reason?: string): Promise<TimeOffRequest>
// 1. findOne(id)
// 2. if status !== PENDING → throw RequestConflictException(status)
// 3. request.status = REJECTED; request.rejectionReason = reason ?? null
// 4. await requestRepo.save(request)
// Returns: rejected TimeOffRequest

cancel(id: string, traceId: string): Promise<TimeOffRequest>
// 1. findOne(id)
// 2. if status !== APPROVED → throw RequestConflictException(status)
// 3. await hcmAdapter.restore(eid, lid, days, id)
//    → HcmUnavailableException on failure (no state change)
// 4. await dataSource.transaction(async manager => {
//      await balancesService.restoreWithLock(eid, lid, days, id, traceId, manager)
//      await manager.save(TimeOffRequest, { ...request, status: CANCELLED })
//    })
// Returns: cancelled TimeOffRequest
```

**Module wiring:**

```typescript
@Module({
  imports: [
    TypeOrmModule.forFeature([TimeOffRequest]),
    BalancesModule,   // provides BalancesService
  ],
  providers: [TimeOffRequestsService],
  exports: [TimeOffRequestsService],
})
export class TimeOffRequestsModule {}
```

Note: `HCM_ADAPTER_TOKEN` is NOT imported from a module here — unit and integration tests provide it via `useValue` mock. Full app wiring happens in F-04/F-07.

**Unit test setup (mocking strategy):**

All dependencies mocked:
- `Repository<TimeOffRequest>` → `jest.fn()` on `.findOneBy()`, `.save()`, `.createQueryBuilder()`
- `BalancesService` → `jest.fn()` on `.findOne()`, `.defensiveCheck()`, `.deductWithLock()`, `.restoreWithLock()`
- `IHcmAdapter` (via `HCM_ADAPTER_TOKEN`) → `jest.fn()` on `.deduct()`, `.restore()`
- `DataSource` → `jest.fn()` on `.transaction()` — mock to execute the callback synchronously with a mock manager

**Test cases (all 10 must be RED before implementation begins):**

| ID | Method | Scenario | Setup | Expected |
|----|--------|----------|-------|----------|
| U-R-01 | `approve` | PENDING + HCM success | balance sufficient; `hcm.deduct` resolves; `deductWithLock` resolves | status → APPROVED; `deductWithLock` called once; `hcm.deduct` called once |
| U-R-02 | `approve` | Request is REJECTED | `findOne` returns REJECTED request | throws `RequestConflictException`; `hcm.deduct` NOT called |
| U-R-03 | `approve` | Request is APPROVED | `findOne` returns APPROVED request | throws `RequestConflictException`; `hcm.deduct` NOT called |
| U-R-04 | `approve` | HCM returns rejection (4xx) | `hcm.deduct` throws `HcmRejectionException` | throws `HcmRejectionException`; `deductWithLock` NOT called; request status unchanged |
| U-R-05 | `approve` | HCM timeout/unavailable | `hcm.deduct` throws `HcmUnavailableException` | throws `HcmUnavailableException`; `deductWithLock` NOT called; request status unchanged |
| U-R-06 | `reject` | PENDING request | `findOne` returns PENDING request | status → REJECTED; `hcm.deduct` NOT called; `deductWithLock` NOT called |
| U-R-07 | `reject` | Request is APPROVED | `findOne` returns APPROVED request | throws `RequestConflictException` |
| U-R-08 | `cancel` | APPROVED + HCM success | `hcm.restore` resolves; `restoreWithLock` resolves | status → CANCELLED; `restoreWithLock` called once; `hcm.restore` called once |
| U-R-09 | `cancel` | Request is PENDING | `findOne` returns PENDING request | throws `RequestConflictException`; `hcm.restore` NOT called |
| U-R-10 | `cancel` | HCM timeout/unavailable | `hcm.restore` throws `HcmUnavailableException` | throws `HcmUnavailableException`; `restoreWithLock` NOT called; request status unchanged |

**Done when:**
- [ ] All 10 unit tests exist and are confirmed FAILING before implementation (RED phase)
- [ ] `TimeOffRequestsService` implements `submit`, `findOne`, `approve`, `reject`, `cancel`
- [ ] All 10 unit tests pass (GREEN phase)
- [ ] `TimeOffRequestsModule` providers: `TimeOffRequestsService`; imports: `TypeOrmModule.forFeature([TimeOffRequest])`, `BalancesModule`; exports: `TimeOffRequestsService`
- [ ] `npm run test -- --testPathPattern=time-off-requests.service.spec` exits 0, **10 tests pass**
- [ ] `npm run build` exits 0

**Tests:** unit (U-R-01..U-R-10)
**Gate:** quick — `npm run test -- --testPathPattern=time-off-requests.service.spec`

---

### T6: Integration tests I-01 + I-02

**What:** Write integration tests against a real SQLite `:memory:` database. These verify that the overlap detection SQL query in `submit()` is correct — both for overlapping date ranges (must reject) and adjacent date ranges (must allow).

**Where:**
- `test/integration/time-off-requests.integration.spec.ts` — new

**Depends on:** T5

**Test module setup pattern (mirrors balances.integration.spec.ts):**

```typescript
const module = await Test.createTestingModule({
  imports: [
    TypeOrmModule.forRoot({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [TimeOffRequest, Balance, SyncLog],
      synchronize: true,
    }),
    TypeOrmModule.forFeature([TimeOffRequest, Balance, SyncLog]),
    BalancesModule,
  ],
  providers: [
    TimeOffRequestsService,
    SyncLogService,
    { provide: HCM_ADAPTER_TOKEN, useValue: { deduct: jest.fn(), restore: jest.fn(), ping: jest.fn() } },
    { provide: DataSource, useValue: mockDataSource }, // transaction wrapper mock
  ],
}).compile();
```

> **Note on DataSource mock for integration tests:** The overlap check is inside `submit()` which calls `requestRepo.createQueryBuilder()` — a real SQLite query. The `DataSource.transaction()` is only used by `approve()` and `cancel()` which are not called in I-01/I-02. Mock `DataSource` with a simple passthrough.

**Test cases:**

| ID | Scenario | Setup | Steps | Expected |
|----|----------|-------|-------|----------|
| I-01 | Overlapping request | Seed a balance + one PENDING request for employee E-1, location L-1, dates `2026-06-01` to `2026-06-10`. | Call `service.submit({ ..., startDate: '2026-06-05', endDate: '2026-06-15', days: 11 })` for same employee/location (overlaps 2026-06-05 to 2026-06-10) | Throws `RequestConflictException` |
| I-02 | Adjacent request (end == next start) | Seed a balance + one PENDING request for same employee, dates `2026-06-01` to `2026-06-10`. | Call `service.submit({ ..., startDate: '2026-06-10', endDate: '2026-06-15', days: 5 })` (starts exactly on end date of existing request) | Returns a new `TimeOffRequest` with status `PENDING`; no exception thrown |

**Overlap SQL correctness note (I-02):**

I-02 validates that `start_date < :endDate AND end_date > :startDate` (strict inequalities) does NOT match when `new.startDate == existing.endDate`. The adjacent case must NOT produce a conflict.

**Done when:**
- [ ] `test/integration/time-off-requests.integration.spec.ts` exists with I-01 and I-02
- [ ] I-01: confirms `RequestConflictException` thrown for overlapping dates with real SQLite
- [ ] I-02: confirms no exception for adjacent dates (start of new == end of existing); new request created
- [ ] `npm run test -- --testPathPattern=time-off-requests.integration.spec` exits 0, **2 tests pass**
- [ ] `npm run build` exits 0

**Tests:** integration (I-01, I-02)
**Gate:** full — `npm run test -- --testPathPattern=time-off-requests.integration.spec`

---

## Parallel Execution Map

```
Phase 1 (All parallel — different files, no conflicts):
  T1 (TimeOffRequest entity)         [P]
  T2 (New domain exceptions)         [P]  } All start simultaneously
  T3 (IHcmAdapter port)              [P]
  T4 (BalancesService extend)        [P]

Phase 2 (Sequential — after ALL Phase 1 tasks complete):
  T1 + T2 + T3 + T4 ──→ T5 (TimeOffRequestsService + unit tests)

Phase 3 (Sequential — after T5):
  T5 ──→ T6 (integration tests I-01 + I-02)
```

**Parallelism constraint verification:**
- T1, T2, T3, T4 touch 8 different files across 4 different directories — no merge conflicts possible ✅
- Unit tests (`test/unit/`) are parallel-safe (isolated mocks, no shared state) ✅
- Integration tests run after unit tests complete (T6 after T5) — no parallelism issue ✅

---

## Validation Report

### Check 1: Task Granularity

| Task | Scope | Status |
|------|-------|--------|
| T1: TimeOffRequest entity + enum | 1 entity file + 1 module update | ✅ Granular |
| T2: New domain exceptions | 3 small files + 1 barrel update (all exceptions — cohesive group) | ✅ Granular |
| T3: IHcmAdapter interface | 1 file (pure interface definition) | ✅ Granular |
| T4: BalancesService EntityManager extension | 1 service file (2 method signatures) + 1 test file (1 test added) | ✅ Granular |
| T5: TimeOffRequestsService + unit tests | 1 service file + 1 test file + 1 module update | ✅ Granular |
| T6: Integration tests | 1 test file | ✅ Granular |

### Check 2: Diagram-Definition Cross-Check

| Task | Depends On (body) | Diagram Shows | Status |
|------|-------------------|---------------|--------|
| T1 | None | Start [P] | ✅ Match |
| T2 | None | Start [P] | ✅ Match |
| T3 | None | Start [P] | ✅ Match |
| T4 | None (F-02 existing) | Start [P] | ✅ Match |
| T5 | T1, T2, T3, T4 | T1+T2+T3+T4 → T5 | ✅ Match |
| T6 | T5 | T5 → T6 | ✅ Match |

No parallel tasks depend on each other. ✅

### Check 3: Test Co-location Validation

Source: `docs/TEST_STRATEGY.md`

| Task | Code Layer | TEST_STRATEGY Requires | Task Says | Status |
|------|-----------|------------------------|-----------|--------|
| T1: TimeOffRequest entity | Entity (no logic) | None | none | ✅ OK |
| T2: Domain exceptions | Value objects (no logic) | None | none | ✅ OK |
| T3: IHcmAdapter port | Interface (no runtime code) | None | none | ✅ OK |
| T4: BalancesService extension | Service (new branch in existing method) | Unit | Unit (U-B-07 + verify 6 existing) | ✅ Match |
| T5: TimeOffRequestsService | Service — state machine logic | Unit | Unit (U-R-01..10) | ✅ Match |
| T6: Overlap detection (SQL) | Integration — real SQLite query correctness | Integration | Integration (I-01, I-02) | ✅ Match |

All test assignments match TEST_STRATEGY.md. ✅
No deferred tests ("tested in another task"). ✅

---

## Pre-execution Note

All Phase 1 tasks require:
- F-02 complete (Balance entity, BalancesService, SyncLog, domain exceptions base) — ✅ Done on `feat/Tasks-f02`
- `npm run build` currently exits 0 — ✅ Confirmed in HANDOFF.md

Ensure all Phase 1 sub-agents start from the same commit on `feat/Tasks-f02` (or a new branch branched from it).
