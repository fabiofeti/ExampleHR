# ExampleHR — Time-Off Microservice

A NestJS + SQLite microservice that manages the full lifecycle of employee time-off requests and keeps balances synchronized with an external Human Capital Management (HCM) system.

## Problem Statement

ExampleHR is the employee-facing interface for time-off requests. The HCM (e.g., Workday, SAP) is the authoritative source of truth for leave balances. Keeping both systems consistent is non-trivial because:

- HCM balances can change independently (work anniversaries, year-start refresh).
- HCM provides both a real-time API and a batch sync endpoint.
- HCM error responses are authoritative but not guaranteed — the service must be defensively correct.

## Deliverables

| Artifact | Location |
|----------|----------|
| Technical Requirements Document | [`docs/TRD.md`](docs/TRD.md) |
| Source code | `src/` |
| Test suite & coverage report | `test/` + `coverage/` |

## Documentation Index

| Document | Description |
|----------|-------------|
| [`docs/PREMISES.md`](docs/PREMISES.md) | Core assumptions and non-negotiable constraints |
| [`docs/SCOPE.md`](docs/SCOPE.md) | In-scope features and explicit exclusions |
| [`docs/USE_CASES.md`](docs/USE_CASES.md) | Actor-based use cases with pre/post conditions |
| [`docs/TRD.md`](docs/TRD.md) | Full TRD: challenges, solution, alternatives |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | System context and sequence diagrams (Mermaid) |
| [`docs/DATA_MODEL.md`](docs/DATA_MODEL.md) | Entity-relationship diagram and table descriptions |
| [`docs/API_SPEC.md`](docs/API_SPEC.md) | REST endpoint contracts |
| [`docs/TEST_STRATEGY.md`](docs/TEST_STRATEGY.md) | Test pyramid, mock HCM design, coverage targets |

## Quick Start

```bash
npm install
npm run start:dev
```

The service starts on `http://localhost:3000`.

## Running Tests

```bash
npm run test          # unit + integration
npm run test:e2e      # end-to-end with mock HCM server
npm run test:cov      # with coverage report
```

## Tech Stack

- **NestJS** — framework
- **SQLite + TypeORM** — persistence
- **Jest + Supertest** — testing
- **Express** — embedded mock HCM server (test only)
