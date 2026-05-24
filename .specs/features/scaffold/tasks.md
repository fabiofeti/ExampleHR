# F-01 NestJS Scaffold — Tasks

**Feature:** F-01 — NestJS project scaffold
**Milestone:** M1 — `npm run start` boots with empty DB
**Status:** Complete ✅
**Refs:** `CLAUDE.md`, `docs/CLEAN_CODE.md`, `docs/RESILIENCE.md`

---

## Execution Plan

### Phase 1: Foundation (Sequential)

```
T1 (scaffold files) → T2 (install deps)
```

### Phase 2: Config Layer (Parallel after T1)

T3 and T4 can run in parallel with T2 — they modify config files only, no npm dep required.

```
T1 ──┬──→ T2 (install deps) ──────────────────────────────┐
     ├──→ T3 (tsconfig) [P] ──────────────────────────────┤
     └──→ T4 (.env files) [P] ────────────────────────────┤
                                                           ▼
                                              T5 (module stubs, after T2)
```

### Phase 3: Module Stubs (after T2)

```
T2 ──→ T5 (empty module stubs)
```

### Phase 4: Wiring (Sequential)

```
T3, T4, T5 ──→ T6 (AppModule) ──→ T7 (main.ts)
```

---

## Task Breakdown

### T1: Scaffold NestJS project core files

**What:** Bootstrap the NestJS project in the current directory — create `package.json` (with NestJS 10 core deps + Jest config + npm scripts), `nest-cli.json`, `tsconfig.json`, `tsconfig.build.json`, `.eslintrc.js`, `.prettierrc`, `src/main.ts` (minimal bootstrap), `src/app.module.ts` (bare `@Module`). Preserve existing `README.md`, `CLAUDE.md`, `.gitignore`.
**Where:** `/home/fabiofeti/projects/ExampleHR/`
**Depends on:** None
**Approach:** Run `npx @nestjs/cli@latest new . --skip-git --package-manager npm`. If the CLI refuses an existing directory, create the files manually. Do NOT overwrite `README.md`, `CLAUDE.md`, `.gitignore`, `docs/`, `.specs/`, `.claude/`.

**Done when:**
- [ ] `package.json` exists with `@nestjs/core`, `@nestjs/common`, `@nestjs/platform-express`, `reflect-metadata`, `rxjs`
- [ ] `nest-cli.json` exists
- [ ] `tsconfig.json` and `tsconfig.build.json` exist
- [ ] `src/main.ts` and `src/app.module.ts` exist
- [ ] Existing project files (`CLAUDE.md`, `docs/`, `.specs/`) are untouched

**Tests:** none
**Gate:** build

---

### T2: Install all project dependencies

**What:** Add all runtime and dev dependencies to `package.json` and run `npm install`.
**Where:** `package.json`
**Depends on:** T1

**Runtime deps to add:**
```
@nestjs/typeorm typeorm better-sqlite3
@nestjs/config joi
@nestjs/terminus
opossum
class-validator class-transformer
axios
```

**Dev deps to add:**
```
@types/better-sqlite3 @types/opossum
supertest @types/supertest
@nestjs/testing
```

**Done when:**
- [ ] All packages appear in `package.json` under correct dep section
- [ ] `node_modules/` exists and `npm install` exits 0
- [ ] `npm run build` exits 0 (TypeScript compiles)

**Tests:** none
**Gate:** build — `npm run build`

---

### T3: Configure strict TypeScript [P]

**What:** Update `tsconfig.json` to enforce strict mode as required by `docs/CLEAN_CODE.md` section 6.
**Where:** `tsconfig.json`
**Depends on:** T1

**Required compiler options:**
```json
{
  "strict": true,
  "noImplicitAny": true,
  "strictNullChecks": true,
  "noUncheckedIndexedAccess": true
}
```

**Done when:**
- [ ] All four options present in `tsconfig.json`
- [ ] `npm run build` still exits 0 (no new type errors from strict mode on the bare scaffold)

**Tests:** none
**Gate:** build — `npm run build`

---

### T4: Create `.env.example` and local `.env` [P]

**What:** Create both env files with all required variables from `docs/CLEAN_CODE.md` section 7. The `.env` file uses dev-safe defaults and is gitignored.
**Where:** `.env.example`, `.env`
**Depends on:** T1

**Content (both files, `.env` uses concrete local values):**
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

**Done when:**
- [ ] `.env.example` committed (already in `.gitignore` scope for `.env` not `.env.example`)
- [ ] `.env` exists locally and is gitignored (confirmed in `.gitignore`)
- [ ] All 9 variables present in both files

**Tests:** none
**Gate:** build

---

### T5: Create empty domain module stubs

**What:** Create one NestJS module file per bounded context. Each module is empty (`@Module({})`) — no providers, controllers, or imports yet. These are the slots future features fill in.
**Where:** `src/` subdirectories per `docs/CLEAN_CODE.md` section 1

**Files to create:**

| File | Module class |
|------|-------------|
| `src/balances/balances.module.ts` | `BalancesModule` |
| `src/time-off-requests/time-off-requests.module.ts` | `TimeOffRequestsModule` |
| `src/hcm-sync/hcm-sync.module.ts` | `HcmSyncModule` |
| `src/sync-log/sync-log.module.ts` | `SyncLogModule` |
| `src/health/health.module.ts` | `HealthModule` |
| `src/common/common.module.ts` | `CommonModule` |

**Depends on:** T2 (needs `@nestjs/common` installed)

**Done when:**
- [ ] All 6 module files exist
- [ ] Each file exports a class decorated with `@Module({})`
- [ ] No TypeScript errors in any module file
- [ ] `npm run build` exits 0

**Tests:** none
**Gate:** build — `npm run build`

---

### T6: Configure AppModule

**What:** Wire all infrastructure and domain modules into `AppModule`. This is the single wiring point — no business logic lives here.
**Where:** `src/app.module.ts`
**Depends on:** T3, T4, T5

**Imports to configure:**

1. **`ConfigModule`** — global, with Joi validation schema for all 9 required env vars. Invalid/missing vars must fail at startup, not at runtime.
2. **`TypeOrmModule`** — SQLite driver (`better-sqlite3`), `DATABASE_PATH` from `ConfigService`, `autoLoadEntities: true`, `synchronize: true` (dev only — controlled by env var in future).
3. **All 6 domain modules** — `BalancesModule`, `TimeOffRequestsModule`, `HcmSyncModule`, `SyncLogModule`, `HealthModule`, `CommonModule`.

**Remove** the default NestJS starter `AppService` and `AppController` if scaffolded by CLI (they are not part of the architecture).

**Done when:**
- [ ] `ConfigModule.forRoot()` present with `isGlobal: true` and Joi schema covering all 9 vars
- [ ] `TypeOrmModule.forRootAsync()` uses `ConfigService` (no direct `process.env` access)
- [ ] All 6 domain modules listed in `imports`
- [ ] No `AppService` or `AppController` in the module
- [ ] `npm run build` exits 0

**Tests:** none
**Gate:** build — `npm run build`

---

### T7: Configure `main.ts`

**What:** Set up the NestJS application bootstrap with all cross-cutting configuration: global API prefix, global `ValidationPipe`, graceful shutdown hooks, and dynamic port from config.
**Where:** `src/main.ts`
**Depends on:** T6

**Required configuration:**
```typescript
app.setGlobalPrefix('v1');
app.useGlobalPipes(new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
}));
app.enableShutdownHooks();
const port = app.get(ConfigService).get<number>('PORT', 3000);
await app.listen(port);
```

**Done when:**
- [ ] Global prefix `v1` set
- [ ] `ValidationPipe` registered globally with `whitelist`, `forbidNonWhitelisted`, `transform`
- [ ] `enableShutdownHooks()` called
- [ ] Port read from `ConfigService`, not `process.env`
- [ ] `npm run build` exits 0
- [ ] `npm run start:dev` boots without errors (milestone M1 ✅)
- [ ] `curl http://localhost:3000/v1/` returns 404 (no routes yet — expected)

**Tests:** none
**Gate:** build — `npm run build` + smoke: `npm run start:dev` boots

**Commit:** `feat(scaffold): NestJS project scaffold with TypeORM, ConfigModule, and domain module stubs`

---

## Parallel Execution Map

```
Phase 1 (Sequential):
  T1 (scaffold files)

Phase 2 (Parallel — all start after T1 completes):
  T1 ──→ T2 (npm install)   [sequential, long-running]
  T1 ──→ T3 (tsconfig) [P]  [parallel with T2]
  T1 ──→ T4 (.env)     [P]  [parallel with T2]

Phase 3 (After T2):
  T2 ──→ T5 (module stubs)

Phase 4 (Sequential):
  T3 + T4 + T5 ──→ T6 (AppModule) ──→ T7 (main.ts)
```

**Note:** T3 and T4 are marked `[P]` — they can run simultaneously with T2. They edit config files only and have no conflict with npm install. T5 must wait for T2 because `@nestjs/common` must be installed before the module files can compile.

---

## Validation Reports

### Check 1: Task Granularity

| Task | Scope | Status |
|------|-------|--------|
| T1: Scaffold project files | ~6 files (one atomic CLI or manual operation) | ✅ Granular |
| T2: Install dependencies | 1 `npm install` + package.json update | ✅ Granular |
| T3: Configure tsconfig | 1 file, 4 compiler options | ✅ Granular |
| T4: Create .env files | 2 files, same content (cohesive pair) | ✅ Granular |
| T5: Create module stubs | 6 files, identical empty pattern | ✅ Granular (same pattern, no logic) |
| T6: Configure AppModule | 1 file | ✅ Granular |
| T7: Configure main.ts | 1 file | ✅ Granular |

### Check 2: Diagram-Definition Cross-Check

| Task | Depends On (body) | Diagram Shows | Status |
|------|-------------------|---------------|--------|
| T1 | None | Start | ✅ Match |
| T2 | T1 | T1 → T2 | ✅ Match |
| T3 | T1 | T1 → T3 [P] | ✅ Match |
| T4 | T1 | T1 → T4 [P] | ✅ Match |
| T5 | T2 | T2 → T5 | ✅ Match |
| T6 | T3, T4, T5 | T3 + T4 + T5 → T6 | ✅ Match |
| T7 | T6 | T6 → T7 | ✅ Match |

No parallel tasks depend on each other. ✅

### Check 3: Test Co-location Validation

Source: `docs/TEST_STRATEGY.md` — tests cover service-layer business logic, integration SQL queries, and E2E HTTP paths. The scaffold creates zero business logic; all code here is wiring/bootstrap.

| Task | Code Layer | TEST_STRATEGY Requires | Task Says | Status |
|------|-----------|------------------------|-----------|--------|
| T1: Scaffold files | Bootstrap (main.ts, app.module.ts) | None (wiring only) | none | ✅ OK |
| T2: Install deps | Package manifest | None | none | ✅ OK |
| T3: tsconfig | Config | None | none | ✅ OK |
| T4: .env files | Config | None | none | ✅ OK |
| T5: Module stubs | Module wiring (empty providers) | None (no logic) | none | ✅ OK |
| T6: AppModule | Module wiring | None (no logic) | none | ✅ OK |
| T7: main.ts | Bootstrap | None (E2E tests in F-09) | none | ✅ OK |

All `Tests: none` entries are valid — the scaffold produces no testable business logic. E2E boot tests (that the app starts and routes return expected status codes) will be written in F-09.

---

## Pre-execution Note

Before running `break into tasks` for **F-02** or **F-03**, create `.specs/codebase/TESTING.md` (the skill's test coverage matrix format). This file drives test type assignment and gate check commands for all subsequent feature tasks. It can be created as a quick task after M1 is confirmed.
