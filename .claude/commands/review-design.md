# /review-design

Review the current implementation against the design specifications for the ExampleHR Time-Off Microservice.

## Scope

You are performing a design compliance review — checking that the implemented code matches the documented intent. This is not a code quality review (that's a separate concern).

Check the following:
1. All endpoints in `API_SPEC.md` are implemented with correct paths, methods, request shapes, and response shapes.
2. The request status state machine in `ARCHITECTURE.md` (section 6) matches the implementation in `TimeOffRequestsService`.
3. All challenges (C1–C7) in `TRD.md` have corresponding implementations.
4. The HCM sync flows (sections 4 and 5 of `ARCHITECTURE.md`) match `HcmSyncService`.
5. The circuit breaker, retry, and health check from `RESILIENCE.md` are implemented in `HcmAdapterService` and `HealthModule`.
6. No module violates the layering rules in `CLEAN_CODE.md` (no business logic in controllers, no raw queries in services).
7. The `balances` table optimistic lock (`version` column) is used in every balance write.

## Documents to read before reviewing

- @docs/TRD.md — challenges C1–C7 and their specified solutions
- @docs/PREMISES.md — non-negotiable constraints that must be honoured
- @docs/SCOPE.md — explicit in-scope and out-of-scope features
- @docs/ARCHITECTURE.md — state machine diagram, sync flow diagrams, component diagram

## Review output format

For each check above, report one of:
- ✅ **Compliant** — implementation matches spec
- ⚠️ **Partial** — partially implemented; describe what is missing
- ❌ **Non-compliant** — implementation diverges from spec; describe the gap

End the review with a prioritized list of gaps to fix (if any), ordered by severity.

## Do NOT load

- `docs/CLEAN_CODE.md` — review rules 6 above suffice; no need to re-read full doc
- `docs/TEST_STRATEGY.md` — test coverage is reviewed separately
- `docs/DATA_MODEL.md` — schema compliance is covered by optimistic lock check
- `docs/ERROR_HANDLING.md` — not in scope for this review session
- `docs/API_SPEC.md` — endpoint shape is confirmed during /implement-api; not re-reviewed here
