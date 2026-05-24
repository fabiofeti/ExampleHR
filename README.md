# ExampleHR — Time-Off Microservice

A NestJS + SQLite microservice that manages the full lifecycle of employee time-off requests and keeps balances synchronized with an external Human Capital Management (HCM) system.

## Problem Statement

ExampleHR is the employee-facing interface for time-off requests. The HCM (e.g., Workday, SAP) is the authoritative source of truth for leave balances. Keeping both systems consistent is non-trivial because:

- HCM balances can change independently (work anniversaries, year-start refresh).
- HCM provides both a real-time webhook and a batch sync endpoint.
- HCM error responses are authoritative — the service must be defensively correct.

---

## Prerequisites

- **Node.js** v16+ (tested on v16.20.2)
- **npm** v8+

No other infrastructure is required. SQLite is embedded and the HCM is replaced by an included mock server.

---

## Installation

```bash
git clone <repository-url>
cd ExampleHR
npm install
```

---

## Running the Application

### Option A — App only (no HCM connectivity)

```bash
npm run start
```

The service starts on **http://localhost:3000**. The `/v1/health` endpoint will report `degraded` because no HCM is reachable — all read operations still work normally.

### Option B — App + Mock HCM (full local stack)

Open two terminals:

**Terminal 1 — Mock HCM server:**
```bash
npm run mock-hcm
```
Starts on **http://localhost:4001**

**Terminal 2 — App pointed at mock HCM:**
```bash
HCM_BASE_URL=http://localhost:4001 npm run start
```

Health check should now return `ok`:
```bash
curl http://localhost:3000/v1/health
# {"status":"ok","info":{"db":{"status":"up"},"hcm":{"status":"up"}},...}
```

### Using a `.env` file (optional)

Create a `.env` file in the project root to avoid setting env vars on every start:

```env
HCM_BASE_URL=http://localhost:4001
PORT=3000
```

Then just run `npm run start`.

---

## Swagger UI

Once the app is running, the interactive API explorer is available at:

**http://localhost:3000/api**

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Port the app listens on |
| `HCM_BASE_URL` | *(none)* | Base URL of the HCM server (use mock for local dev) |
| `CIRCUIT_BREAKER_VOLUME` | `10` | Minimum calls before circuit can open |
| `CIRCUIT_BREAKER_THRESHOLD` | `50` | Error % threshold to open circuit |
| `CIRCUIT_BREAKER_RESET_MS` | `30000` | Time (ms) before circuit transitions to half-open |
| `HCM_TIMEOUT_MS` | `5000` | Timeout (ms) per HCM HTTP call |
| `MOCK_HCM_PORT` | `4001` | Port for the standalone mock HCM server |
| `APP_URL` | `http://localhost:3000` | App URL used by mock HCM to push webhooks |

---

## Running Tests

All test commands are self-contained — no external services need to be running.

```bash
# Unit + integration tests
npm run test

# E2E tests (spins up mock HCM automatically on port 4001)
npm run test:e2e

# Full suite with coverage report
npm run test:cov
```

Expected results:

```
npm run test     →  85 tests,  11 suites,  all pass
npm run test:e2e →  14 tests,   2 suites,  all pass
npm run test:cov →  Statements 99.75% | Branches 96.42% | Lines 99.73%
```

Coverage report is written to `coverage/lcov-report/index.html` and can be opened in a browser.

> **Note on `[ERROR] Health Check has failed!` log lines**
>
> You will see a few lines like this during `npm run test`:
> ```
> [Nest] ERROR [Testing] Health Check has failed! {"hcm":{"status":"down"}}
> [Nest] ERROR [Testing] Health Check has failed! {"db":{"status":"down"}}
> ```
> These are **expected and intentional**. The health integration tests (R-06, R-07) deliberately simulate an unreachable HCM and a destroyed database connection to verify the degraded/down behaviour. NestJS's `TerminusModule` always logs at `ERROR` level when any indicator fails — that is framework behaviour, not a defect. All tests still pass.

---

## Mock HCM Server

The mock HCM (`npm run mock-hcm`) is a lightweight Express server that simulates the external HCM API. It supports configurable failure modes useful for manual exploration:

### Control endpoints

| Method | Path | Body | Description |
|---|---|---|---|
| `POST` | `/mock/set-balance` | `{ employeeId, locationId, available, used, total }` | Seed a balance |
| `POST` | `/mock/set-mode` | `{ mode }` | Set failure mode (see below) |
| `POST` | `/mock/reset` | — | Reset all state |
| `GET` | `/mock/call-log` | — | See all calls the app made to HCM |
| `POST` | `/mock/push-realtime` | balance payload | Trigger a realtime webhook to the app |
| `POST` | `/mock/push-batch` | `{ balances: [...] }` | Trigger a batch sync to the app |

### Failure modes

| Mode | Behavior |
|---|---|
| `normal` | Standard balance validation |
| `error-next` | Next call returns 500, then resets to normal |
| `error-always` | All calls return 500 (persistent) |
| `reject-next` | Next deduct returns 422 INSUFFICIENT_BALANCE |
| `timeout-next` | Next call hangs for 10s (simulates timeout) |
| `accept-all` | Accepts any deduction without balance checks |

### Example walkthrough

```bash
# 1. Seed a balance
curl -X POST http://localhost:4001/mock/set-balance \
  -H "Content-Type: application/json" \
  -d '{"employeeId":"EMP-1","locationId":"LOC-1","available":10,"used":0,"total":10}'

# 2. Submit a time-off request
curl -X POST http://localhost:3000/v1/time-off-requests \
  -H "Content-Type: application/json" \
  -d '{"employeeId":"EMP-1","locationId":"LOC-1","startDate":"2026-07-01","endDate":"2026-07-05","days":5}'

# 3. Approve it (replace <id> with the id from step 2)
curl -X PATCH http://localhost:3000/v1/time-off-requests/<id>/approve

# 4. Check the updated balance
curl http://localhost:3000/v1/balances/EMP-1/LOC-1

# 5. See what calls the app made to HCM
curl http://localhost:4001/mock/call-log
```

---

## API Overview

All routes are prefixed with `/v1`. Full contract in [`docs/API_SPEC.md`](docs/API_SPEC.md).

| Method | Path | Description |
|---|---|---|
| `GET` | `/v1/health` | Health check (DB + HCM) |
| `GET` | `/v1/balances/:employeeId/:locationId` | Get leave balance |
| `POST` | `/v1/time-off-requests` | Submit a request |
| `GET` | `/v1/time-off-requests` | List requests (filterable) |
| `GET` | `/v1/time-off-requests/:id` | Get a single request |
| `PATCH` | `/v1/time-off-requests/:id/approve` | Approve a request |
| `PATCH` | `/v1/time-off-requests/:id/reject` | Reject a request |
| `PATCH` | `/v1/time-off-requests/:id/cancel` | Cancel a request |
| `POST` | `/v1/hcm/sync/realtime` | Ingest a single HCM balance update |
| `POST` | `/v1/hcm/sync/batch` | Ingest a full HCM balance dump |

---

## Architecture & Design

| Document | Description |
|---|---|
| [`docs/TRD.md`](docs/TRD.md) | Technical Requirements Document — challenges, solution, alternatives |
| [`docs/PREMISES.md`](docs/PREMISES.md) | Core assumptions and constraints |
| [`docs/SCOPE.md`](docs/SCOPE.md) | In-scope features and explicit exclusions |
| [`docs/USE_CASES.md`](docs/USE_CASES.md) | Actor-based use cases with pre/post conditions |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | System context and sequence diagrams |
| [`docs/DATA_MODEL.md`](docs/DATA_MODEL.md) | Entity-relationship diagram and table descriptions |
| [`docs/API_SPEC.md`](docs/API_SPEC.md) | Full REST endpoint contracts |
| [`docs/TEST_STRATEGY.md`](docs/TEST_STRATEGY.md) | Test pyramid, mock HCM design, coverage targets |
| [`docs/RESILIENCE.md`](docs/RESILIENCE.md) | Circuit breaker, retry, and graceful shutdown patterns |

---

## Tech Stack

- **NestJS** — framework
- **SQLite + TypeORM** — persistence (no database server needed)
- **Jest + Supertest** — testing
- **opossum** — circuit breaker for HCM calls
- **Express** — embedded mock HCM server (test + local dev)
- **@nestjs/swagger** — OpenAPI/Swagger UI
