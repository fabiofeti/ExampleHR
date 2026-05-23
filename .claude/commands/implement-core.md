# /implement-core

Implement the core business logic modules for the ExampleHR Time-Off Microservice.

## Scope

You are implementing two NestJS modules:
- **`balances/`** — `Balance` entity, `BalancesService` (defensive check, optimistic lock write), TypeORM repository.
- **`time-off-requests/`** — `TimeOffRequest` entity, `TimeOffRequestsService` (state machine, approval orchestration), TypeORM repository.

Do NOT implement controllers, DTOs, or the HCM adapter in this session. Do NOT implement HCM calls — those belong in `implement-sync`. Focus entirely on the service-layer business logic and the database layer.

## Documents to read before writing any code

Read all of these in full before generating a single line of code:

- @docs/PREMISES.md — non-negotiable constraints (especially #6 concurrency, #4 HCM reliability)
- @docs/TRD.md — challenges C1–C5 and their solutions; decision log
- @docs/DATA_MODEL.md — exact entity schema, column types, indexes, optimistic lock pattern
- @docs/CLEAN_CODE.md — module structure, strict layering, exception hierarchy, TypeScript rules
- @docs/ERROR_HANDLING.md — which exceptions to throw and when

## Key implementation rules

1. `BalancesService.defensiveCheck(employeeId, locationId, days)` — throws `InsufficientBalanceException` if `balance.available < days`. Throws `NotFoundException` if the balance record does not exist.
2. `BalancesService.deductWithLock(employeeId, locationId, days, expectedVersion)` — UPDATE with `WHERE version = expectedVersion`. If 0 rows affected, throw `BalanceConflictException`.
3. `BalancesService.restoreWithLock(...)` — same pattern, adds days back.
4. `TimeOffRequestsService.approve(id, traceId)` — enforce `PENDING` status; call `defensiveCheck`; call HCM (via injected `IHcmAdapter` token); on HCM success call `deductWithLock` + update status in a single TypeORM transaction; retry once on `BalanceConflictException`.
5. `TimeOffRequestsService.reject(id, reason)` — enforce `PENDING` status; update status only; no HCM call.
6. `TimeOffRequestsService.cancel(id, traceId)` — enforce `APPROVED` status; call HCM restore; on success call `restoreWithLock` + update status in transaction.
7. Overlap detection in `create(dto)` — query for any `PENDING` or `APPROVED` request with overlapping date range for same `(employeeId, locationId)`; throw `RequestConflictException` if found.
8. All services inject `IHcmAdapter` via `HCM_ADAPTER_TOKEN` — never the concrete class.
9. Strict TypeScript: no `any`, enums with string values, ConfigService for all env vars.

## Do NOT load

- `docs/API_SPEC.md` — controllers and DTOs are out of scope here
- `docs/RESILIENCE.md` — circuit breaker is applied inside HcmAdapterService, not in core services
- `docs/TEST_STRATEGY.md` — tests are a separate session (/write-tests)
- `docs/USE_CASES.md` — behavior is fully defined in TRD and DATA_MODEL
- `docs/ARCHITECTURE.md` — diagrams for reference; service code does not need it
