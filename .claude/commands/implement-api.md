# /implement-api

Implement all REST controllers, DTOs, and the global HTTP pipeline for the ExampleHR Time-Off Microservice.

## Scope

You are implementing:
- All request/response DTOs (`class-validator` + `class-transformer`)
- `BalancesController` — `GET /v1/balances/:employeeId/:locationId`
- `TimeOffRequestsController` — POST, GET (list + single), PATCH approve/reject/cancel
- `HcmSyncController` — POST realtime and batch
- `TraceInterceptor` — global, generates `traceId` per request
- `AllExceptionsFilter` — global, maps all exceptions to structured error responses
- Global `ValidationPipe` configuration in `main.ts`
- API versioning: `/v1/` global prefix

Assume all services already exist. Controllers call services — no business logic in controllers.

## Documents to read before writing any code

- @docs/API_SPEC.md — every endpoint contract: URL, method, request body, response shape, status codes, error codes
- @docs/USE_CASES.md — actor intent behind each endpoint (helps write accurate validation rules)
- @docs/CLEAN_CODE.md — DTO conventions, strict layering, naming rules, response DTO pattern
- @docs/ERROR_HANDLING.md — TraceInterceptor spec, AllExceptionsFilter spec, full exception→HTTP mapping table, error response shape

## Key implementation rules

1. **Every controller method** maps directly to a use case: parse DTO, call one service method, return response DTO. No if/else logic, no database calls.
2. **Request DTOs**: `whitelist: true`, `forbidNonWhitelisted: true`, `transform: true` on global `ValidationPipe`.
3. **Response DTOs**: static `.from(entity)` factory method. Never return a TypeORM entity directly.
4. **`TraceInterceptor`**: must run before the exception filter. Returns `X-Trace-Id` header on all responses including errors.
5. **`AllExceptionsFilter`**: handles `DomainException`, `HttpException`, TypeORM `QueryFailedError`, and unknown `Error`. Reads `traceId` from `request.traceId`.
6. **Validation errors** from `ValidationPipe` arrive as `BadRequestException` with a `message` array — the filter must flatten these into the `details` array format.
7. **HCM sync endpoints** (`POST /v1/hcm/sync/realtime` and `/v1/hcm/sync/batch`) should be separated from the main request router — note for gateway-level IP restriction.
8. **Pagination** on `GET /v1/time-off-requests`: `page` default 1, `limit` default 20 max 100. Validate in `QueryTimeOffRequestsDto`.

## Do NOT load

- `docs/TRD.md` — implementation decisions already encoded in services
- `docs/RESILIENCE.md` — circuit breaker lives in HcmAdapterService, not controllers
- `docs/DATA_MODEL.md` — entities already exist; you map them to DTOs, not define them
- `docs/ARCHITECTURE.md` — diagrams not needed for controller/DTO work
- `docs/PREMISES.md` and `docs/SCOPE.md` — foundational context not needed here
