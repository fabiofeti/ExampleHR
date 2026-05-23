# API Specification

Base URL: `http://localhost:3000`  
All requests and responses use `Content-Type: application/json`.

---

## Balances

### GET `/balances/:employeeId/:locationId`

Returns the locally cached leave balance for a specific employee at a specific location.

**Path params:**
| Param | Type | Description |
|-------|------|-------------|
| `employeeId` | string | HCM-issued employee identifier |
| `locationId` | string | HCM-issued location identifier |

**Response 200:**
```json
{
  "employeeId": "E-1001",
  "locationId": "LOC-NYC",
  "available": 8.5,
  "used": 1.5,
  "total": 10.0,
  "version": 3,
  "lastSyncedAt": "2026-05-20T14:00:00Z"
}
```

**Response 404:** Balance record not found for this `(employeeId, locationId)`.

```json
{ "statusCode": 404, "error": "NOT_FOUND", "message": "Balance not found" }
```

---

## Time-Off Requests

### POST `/time-off-requests`

Submits a new time-off request. Creates a record in `PENDING` status. Does **not** call HCM.

**Request body:**
```json
{
  "employeeId": "E-1001",
  "locationId": "LOC-NYC",
  "leaveType": "VACATION",
  "startDate": "2026-06-01",
  "endDate": "2026-06-05",
  "days": 5
}
```

**Validation rules:**
- `startDate` must be a valid ISO date.
- `endDate >= startDate`.
- `days > 0`.
- All fields required.

**Response 201:**
```json
{
  "id": "req-uuid-1234",
  "employeeId": "E-1001",
  "locationId": "LOC-NYC",
  "leaveType": "VACATION",
  "startDate": "2026-06-01",
  "endDate": "2026-06-05",
  "days": 5,
  "status": "PENDING",
  "createdAt": "2026-05-23T10:00:00Z",
  "updatedAt": "2026-05-23T10:00:00Z"
}
```

**Response 409:** Overlapping `PENDING` or `APPROVED` request exists.
```json
{ "statusCode": 409, "error": "CONFLICT", "message": "Overlapping request exists" }
```

**Response 422:** Local balance check fails before submission (optional early rejection).
```json
{ "statusCode": 422, "error": "INSUFFICIENT_BALANCE", "message": "Available balance (3.0) is less than requested (5.0)" }
```

---

### GET `/time-off-requests`

Lists time-off requests with optional filters.

**Query params:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `employeeId` | string | No | Filter by employee |
| `locationId` | string | No | Filter by location |
| `status` | string | No | `PENDING\|APPROVED\|REJECTED\|CANCELLED\|INVALIDATED` |
| `startDate` | ISO date | No | Filter requests with `startDate >=` this value |
| `endDate` | ISO date | No | Filter requests with `endDate <=` this value |
| `page` | int | No | Page number (default: 1) |
| `limit` | int | No | Page size (default: 20, max: 100) |

**Response 200:**
```json
{
  "data": [ /* array of request objects */ ],
  "total": 42,
  "page": 1,
  "limit": 20
}
```

---

### GET `/time-off-requests/:id`

Returns a single request by ID.

**Response 200:** Full request object (same shape as POST 201 response).

**Response 404:**
```json
{ "statusCode": 404, "error": "NOT_FOUND", "message": "Request not found" }
```

---

### PATCH `/time-off-requests/:id/approve`

Approves a `PENDING` request. Triggers the HCM deduction call. Deducts from local balance on success.

**Request body:** None required.

**Response 200:**
```json
{
  "id": "req-uuid-1234",
  "status": "APPROVED",
  "updatedAt": "2026-05-23T10:05:00Z"
  /* ... all other fields */
}
```

**Response 409:** Request is not in `PENDING` status, or optimistic lock conflict.
```json
{ "statusCode": 409, "error": "CONFLICT", "message": "Request is not in PENDING status" }
```

**Response 422:** Local balance insufficient or HCM rejected.
```json
{ "statusCode": 422, "error": "INSUFFICIENT_BALANCE", "message": "Available balance (3.0) is less than requested (5.0)" }
```
```json
{ "statusCode": 422, "error": "HCM_REJECTION", "message": "HCM rejected the deduction: invalid leave type for this location" }
```

**Response 503:** HCM unavailable.
```json
{ "statusCode": 503, "error": "HCM_UNAVAILABLE", "message": "HCM did not respond within the timeout" }
```

---

### PATCH `/time-off-requests/:id/reject`

Rejects a `PENDING` request. No HCM call.

**Request body:**
```json
{ "reason": "Insufficient coverage during this period" }
```
(reason is optional)

**Response 200:** Updated request object with `status: "REJECTED"`.

**Response 409:** Request is not in `PENDING` status.

---

### PATCH `/time-off-requests/:id/cancel`

Cancels an `APPROVED` request. Triggers HCM restoration call. Restores local balance on success.

**Request body:** None required.

**Response 200:** Updated request object with `status: "CANCELLED"`.

**Response 409:** Request is not in `APPROVED` status.

**Response 503:** HCM unavailable — balance and status unchanged.
```json
{ "statusCode": 503, "error": "HCM_UNAVAILABLE", "message": "HCM restoration failed. Manual reconciliation may be required." }
```

---

## HCM Sync (Inbound)

> These endpoints are called by the HCM system, not by employees or managers. They should be protected at the gateway level to HCM's known IP range.

### POST `/hcm/sync/realtime`

Accepts a single balance update pushed by HCM (work anniversary, admin correction, etc.).

**Request body:**
```json
{
  "employeeId": "E-1001",
  "locationId": "LOC-NYC",
  "available": 12.0,
  "used": 2.0,
  "total": 14.0
}
```

**Response 200:**
```json
{
  "updated": 1,
  "invalidated": 0
}
```

**Response 400:** Missing required fields.

---

### POST `/hcm/sync/batch`

Accepts a full balance corpus from HCM. Upserts all records and runs reconciliation.

**Request body:**
```json
{
  "balances": [
    { "employeeId": "E-1001", "locationId": "LOC-NYC", "available": 8.0, "used": 2.0, "total": 10.0 },
    { "employeeId": "E-1002", "locationId": "LOC-LA",  "available": 5.0, "used": 5.0, "total": 10.0 }
  ]
}
```

**Response 200:**
```json
{
  "updated": 2,
  "invalidated": 1,
  "errors": []
}
```

**`errors`** is an array of records that failed to upsert (partial failure is possible):
```json
{
  "errors": [
    { "employeeId": "E-9999", "locationId": "LOC-XX", "reason": "Optimistic lock conflict after 3 retries" }
  ]
}
```

**Response 400:** Payload is not a valid array or is missing `balances` key.

---

## Error Response Shape

All error responses follow this structure:

```json
{
  "statusCode": 422,
  "error": "INSUFFICIENT_BALANCE",
  "message": "Human-readable explanation"
}
```

**Error codes:**

| Code | HTTP Status | Description |
|------|-------------|-------------|
| `NOT_FOUND` | 404 | Resource does not exist |
| `CONFLICT` | 409 | Status conflict or optimistic lock failure |
| `INSUFFICIENT_BALANCE` | 422 | Local balance check failed |
| `HCM_REJECTION` | 422 | HCM returned an error for the deduction |
| `INVALID_DATE_RANGE` | 400 | `endDate < startDate` or invalid date format |
| `HCM_UNAVAILABLE` | 503 | HCM did not respond or returned 5xx |
