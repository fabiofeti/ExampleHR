# Error Handling Strategy

This document defines the complete error handling pipeline: how errors are created, propagated, caught, formatted, and logged. Every component in the system must follow these patterns.

---

## 1. Request Trace Interceptor

**File:** `src/common/interceptors/trace.interceptor.ts`  
**Scope:** Applied globally in `AppModule`.

Every inbound HTTP request gets a `traceId` (UUID v4):
- Attached to `request.traceId` for use in service log calls.
- Returned in response header `X-Trace-Id`.
- Included in all error responses.
- Never stored in the database (it's a per-request ephemeral ID for log correlation).

```typescript
// Pattern for logging inside services:
this.logger.log('Approving request', { traceId, requestId, employeeId });
this.logger.warn('HCM unavailable', { traceId, error: err.message });
```

---

## 2. Global Exception Filter

**File:** `src/common/filters/all-exceptions.filter.ts`  
**Scope:** Applied globally via `APP_FILTER` provider in `AppModule`.

The filter catches **every** unhandled exception and maps it to a structured JSON response. It must handle:

### 2.1 Domain exceptions

Instances of `DomainException` (and subclasses) are already structured — extract `statusCode`, `error`, and `message` from the exception payload and add `traceId`.

### 2.2 NestJS built-in exceptions

`HttpException` subclasses (`NotFoundException`, `BadRequestException`, `ValidationPipe` errors) are mapped using `exception.getStatus()` and `exception.getResponse()`. The `error` code is derived from the HTTP status if not already present.

### 2.3 TypeORM errors

`QueryFailedError` is caught and mapped to:
```json
{ "statusCode": 500, "error": "INTERNAL_ERROR", "message": "A database error occurred", "traceId": "..." }
```
The original SQL error is **never** exposed to the caller (SQL injection surface, sensitive schema info). Log the full error internally at `error` level.

### 2.4 Unknown errors

All other `Error` instances → `500 INTERNAL_ERROR`. Log full stack trace internally.

---

## 3. Exception → HTTP Mapping (Exhaustive)

| Exception Class | Error Code | HTTP Status |
|----------------|------------|-------------|
| `InsufficientBalanceException` | `INSUFFICIENT_BALANCE` | 422 |
| `HcmRejectionException` | `HCM_REJECTION` | 422 |
| `HcmUnavailableException` | `HCM_UNAVAILABLE` | 503 |
| `RequestConflictException` | `CONFLICT` | 409 |
| `BalanceConflictException` | `CONFLICT` | 409 |
| NestJS `NotFoundException` | `NOT_FOUND` | 404 |
| NestJS `BadRequestException` | `BAD_REQUEST` | 400 |
| `ValidationPipe` error | `VALIDATION_ERROR` | 400 |
| TypeORM `QueryFailedError` | `INTERNAL_ERROR` | 500 |
| Any other `Error` | `INTERNAL_ERROR` | 500 |

---

## 4. Error Response Shape

All error responses — from any endpoint, for any reason — follow this exact shape:

```json
{
  "statusCode": 422,
  "error": "INSUFFICIENT_BALANCE",
  "message": "Available balance (3.0) is less than requested days (5.0)",
  "traceId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
}
```

**Rules:**
- `statusCode` is always the HTTP status code (integer).
- `error` is always a `SCREAMING_SNAKE_CASE` machine-readable code.
- `message` is a human-readable string safe to display to end users (no SQL, no stack traces, no internal paths).
- `traceId` is always present (even on 500 errors) so support can correlate logs.

**Validation errors** include an additional `details` array:
```json
{
  "statusCode": 400,
  "error": "VALIDATION_ERROR",
  "message": "Validation failed",
  "traceId": "...",
  "details": [
    { "field": "days", "message": "days must be a positive number" }
  ]
}
```

---

## 5. Structured Logging

**Library:** NestJS built-in `Logger` (inject per class: `private readonly logger = new Logger(MyService.name)`)

**Format:** JSON when `LOG_FORMAT=json` (production default); human-readable when `LOG_FORMAT=pretty` (local dev).

**Log levels:**

| Level | When to use |
|-------|-------------|
| `error` | Unrecoverable failures: DB commit failed, startup crash |
| `warn` | Recoverable but notable: HCM unavailable, retry exhausted, circuit opened, reconciliation triggered |
| `log` | Normal operation events: request approved, balance updated, batch sync completed |
| `debug` | Detailed flow tracing: individual DB queries, HCM response payloads (use sparingly) |
| `verbose` | Very detailed; only enabled in development |

**Log entry shape (JSON):**
```json
{
  "level": "warn",
  "context": "HcmAdapterService",
  "message": "HCM call failed; retry 2/3",
  "traceId": "...",
  "employeeId": "E-1001",
  "locationId": "LOC-NYC",
  "operation": "deduct",
  "error": "timeout after 5000ms",
  "timestamp": "2026-05-23T10:00:00.000Z"
}
```

**Rules:**
- Never log PII (employee names, email addresses, leave reasons if personal data is added).
- Never log raw HCM response payloads in production (`log` level safe; `debug` only).
- Every `warn` or `error` log must include `traceId`.
- Use `context` = class name (NestJS Logger handles this automatically when injected via `Logger(ClassName.name)`).

---

## 6. Domain Exception Reference

### `InsufficientBalanceException`
```typescript
throw new InsufficientBalanceException(balance.available, request.days);
// message: "Available balance (3.0) is less than requested days (5.0)"
```

### `HcmRejectionException`
```typescript
throw new HcmRejectionException(hcmError.reason);
// message: "HCM rejected the operation: invalid leave type for this location"
```

### `HcmUnavailableException`
```typescript
throw new HcmUnavailableException(traceId);
// message: "HCM did not respond within the timeout period. traceId: <id>"
```

### `RequestConflictException`
```typescript
throw new RequestConflictException(request.status);
// message: "Request is not in PENDING status (current: APPROVED)"
```

### `BalanceConflictException`
```typescript
throw new BalanceConflictException();
// message: "Balance was modified concurrently. Please retry."
```

---

## 7. Handling HCM Errors

When HCM returns a 4xx response, parse the body carefully — HCM error shapes may vary by vendor. The `HcmAdapterService` normalizes all HCM errors into:

```typescript
interface HcmError {
  code: 'INSUFFICIENT_BALANCE' | 'INVALID_DIMENSION' | 'EMPLOYEE_NOT_FOUND' | 'UNKNOWN';
  message: string;
}
```

Mapping:
- `INSUFFICIENT_BALANCE` → throw `InsufficientBalanceException` (HCM is authoritative)
- `INVALID_DIMENSION` → throw `HcmRejectionException`
- `EMPLOYEE_NOT_FOUND` → throw `HcmRejectionException`
- `UNKNOWN` → throw `HcmRejectionException` with the raw HCM message

On HCM 5xx or network error → throw `HcmUnavailableException` (do not propagate HCM's 5xx message).

---

## 8. Never Swallow Errors

The following patterns are forbidden:

```typescript
// FORBIDDEN — swallowing errors
try {
  await this.hcm.deduct(...);
} catch (e) {
  // do nothing
}

// FORBIDDEN — generic catch without re-throw or domain exception
} catch (e) {
  return null;
}
```

Every `catch` block must either:
1. Re-throw a typed domain exception.
2. Log + re-throw (`warn` or `error` level depending on severity).
3. Implement dead-letter handling (for retry exhaustion) and then throw `HcmUnavailableException`.
