# Clean Code & Microservice Best Practices

This document defines the coding standards and architectural conventions for the ExampleHR Time-Off Microservice. Every rule here is mandatory — consistency is what makes agentic code generation reliable and reviewable.

---

## 1. Module = Bounded Context

Each NestJS module owns exactly one domain. Modules communicate through injected services, never through direct entity access across module boundaries.

```
src/
  balances/           ← BalancesModule
  time-off-requests/  ← TimeOffRequestsModule
  hcm-sync/           ← HcmSyncModule
  sync-log/           ← SyncLogModule
  health/             ← HealthModule
  common/             ← CommonModule (shared DTOs, filters, interceptors, exceptions)
  app.module.ts
  main.ts
```

**Rule:** A module exports only its public `Service`. It never exports its `Entity` or `Repository`. Other modules that need data ask the service, not the database.

---

## 2. Strict Layering

No layer may skip another. The call chain is always:

```
Controller → Service → Repository (TypeORM) → Entity
```

| Layer | Responsibility | Forbidden |
|-------|---------------|-----------|
| `Controller` | Parse input, call service, map response DTO | Business logic, DB access, HCM calls |
| `Service` | All business rules, orchestration | Raw queries, direct HTTP calls |
| `Repository` | TypeORM queries only | Business logic |
| `Entity` | TypeORM column decorators | Methods, business logic, computed fields |

**Controller test:** If you can delete a method from a controller and the business behavior still works (by calling the service directly), the controller is correct.

---

## 3. Dependency Inversion for HCM

HCM is an external system. Services must not depend on the concrete HTTP adapter — they depend on an interface. This makes the mock trivial and the production adapter swappable.

**File layout:**

```
src/hcm-sync/
  ports/
    hcm-adapter.port.ts       ← IHcmAdapter interface
  adapters/
    hcm-adapter.service.ts    ← implements IHcmAdapter (production, uses axios)
  hcm-sync.module.ts          ← provides HCM_ADAPTER_TOKEN
```

**Interface definition:**

```typescript
export interface IHcmAdapter {
  deduct(employeeId: string, locationId: string, days: number, idempotencyKey: string): Promise<HcmBalanceResponse>;
  restore(employeeId: string, locationId: string, days: number, idempotencyKey: string): Promise<HcmBalanceResponse>;
  ping(): Promise<boolean>;
}

export const HCM_ADAPTER_TOKEN = 'HCM_ADAPTER_TOKEN';
```

**Production injection:**
```typescript
{ provide: HCM_ADAPTER_TOKEN, useClass: HcmAdapterService }
```

**Test override:**
```typescript
{ provide: HCM_ADAPTER_TOKEN, useValue: mockHcmAdapter }
```

Services inject via token:
```typescript
constructor(@Inject(HCM_ADAPTER_TOKEN) private readonly hcm: IHcmAdapter) {}
```

---

## 4. DTO Conventions

**Request DTOs** (`class-validator` + `class-transformer`):
- Use `@IsString()`, `@IsDateString()`, `@IsPositive()`, `@IsEnum()` decorators.
- Use `@Transform(({ value }) => new Date(value))` for date string → `Date` conversion.
- Enable `ValidationPipe` globally with `{ whitelist: true, forbidNonWhitelisted: true, transform: true }`.

**Response DTOs** (plain classes, no decorators needed):
- Never return TypeORM entities from controllers — always map to a response DTO.
- Use a static `.from(entity)` factory method on the DTO class.

**Naming:**
| Type | Convention | Example |
|------|-----------|---------|
| Create request | `Create<X>Dto` | `CreateTimeOffRequestDto` |
| Query/filter | `Query<X>Dto` | `QueryTimeOffRequestsDto` |
| Patch/update | `Update<X>Dto` | `UpdateTimeOffRequestDto` |
| Response | `<X>ResponseDto` | `TimeOffRequestResponseDto` |

---

## 5. Exception Hierarchy

All domain exceptions extend a common base and carry a machine-readable `code`:

```typescript
// src/common/exceptions/domain.exception.ts
export class DomainException extends HttpException {
  constructor(public readonly code: string, message: string, status: number) {
    super({ statusCode: status, error: code, message }, status);
  }
}
```

**Exception classes:**

```
DomainException
  ├── InsufficientBalanceException(available, requested)  → 422
  ├── HcmRejectionException(reason)                       → 422
  ├── HcmUnavailableException(traceId)                    → 503
  ├── RequestConflictException(currentStatus)             → 409
  └── BalanceConflictException()                          → 409
```

**Rule:** Never throw `new Error('something')` in services. Always throw a typed domain exception. This makes the global filter's job deterministic.

---

## 6. TypeScript Strictness

`tsconfig.json` must include:

```json
{
  "compilerOptions": {
    "strict": true,
    "noImplicitAny": true,
    "strictNullChecks": true,
    "noUncheckedIndexedAccess": true
  }
}
```

**Rules:**
- No `any` anywhere. Use `unknown` and type-narrow with type guards.
- No non-null assertions (`!`) except where TypeScript cannot infer what the developer knows. Add a comment explaining why if used.
- Enums use string values (not numeric) so SQLite stores readable strings:
  ```typescript
  export enum RequestStatus {
    PENDING = 'PENDING',
    APPROVED = 'APPROVED',
    REJECTED = 'REJECTED',
    CANCELLED = 'CANCELLED',
    INVALIDATED = 'INVALIDATED',
  }
  ```
- Interface names are prefixed with `I`: `IHcmAdapter`, `IBalanceRepository`.

---

## 7. Configuration Management

All environment variables are accessed via NestJS `ConfigService`. Direct `process.env` access is forbidden in services.

**Required `.env.example`:**

```env
# HCM Integration
HCM_BASE_URL=http://localhost:4000
HCM_TIMEOUT_MS=5000

# Circuit Breaker
CIRCUIT_BREAKER_THRESHOLD=0.5
CIRCUIT_BREAKER_VOLUME=10
CIRCUIT_BREAKER_RESET_TIMEOUT_MS=30000

# Application
PORT=3000
LOG_FORMAT=json
LOG_LEVEL=log

# Database (SQLite)
DATABASE_PATH=./data/examplehr.db
```

**Pattern:**
```typescript
// app.module.ts
ConfigModule.forRoot({ isGlobal: true, validationSchema: Joi.object({
  HCM_BASE_URL: Joi.string().uri().required(),
  HCM_TIMEOUT_MS: Joi.number().default(5000),
  // ...
})})
```

Use `Joi` schema validation on startup so missing required vars fail fast, not at runtime.

---

## 8. Naming Conventions

| Item | Convention | Example |
|------|-----------|---------|
| Files | `kebab-case.ts` | `time-off-requests.service.ts` |
| Classes | `PascalCase` | `TimeOffRequestsService` |
| Interfaces | `I` + `PascalCase` | `IHcmAdapter` |
| Enums | `PascalCase` | `RequestStatus`, `SyncSource` |
| Constants | `UPPER_SNAKE_CASE` | `HCM_ADAPTER_TOKEN` |
| Methods | `camelCase` | `approveRequest()` |
| DB columns | `snake_case` | `employee_id`, `last_synced_at` |
| API fields | `camelCase` | `employeeId`, `lastSyncedAt` |

---

## 9. Testing Conventions

- Unit tests live next to the file they test: `balances.service.spec.ts` beside `balances.service.ts`.
- Integration tests live in `test/integration/`.
- E2E tests live in `test/e2e/`.
- Mock HCM server lives in `test/mock-hcm/`.
- Use `describe` blocks matching the class name; `it` blocks describe behavior in plain English.
- Each test must set up its own state (no shared mutable state between tests).
- Never use `setTimeout` in tests; use mock HCM's `timeout-next` mode + Jest fake timers.

---

## 10. Microservice Principles

- **Single Responsibility:** This service manages time-off requests and balances only. It does not own employee or location data.
- **Loose Coupling:** HCM integration is behind an interface (Premise 7 applied in code).
- **High Cohesion:** All balance logic is in `BalancesService`. All sync logic is in `HcmSyncService`. No cross-service business logic leakage.
- **API Versioning:** All routes prefixed with `/v1/` in `main.ts` global prefix. Future breaking changes go under `/v2/`.
- **No Shared Database:** If this service ever runs alongside other microservices, each owns its own SQLite file. No cross-service joins.
