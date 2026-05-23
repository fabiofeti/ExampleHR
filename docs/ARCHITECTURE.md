# Architecture Diagrams

---

## 1. System Context

```mermaid
C4Context
    title System Context — ExampleHR Time-Off Microservice

    Person(employee, "Employee", "Views balance, submits time-off requests")
    Person(manager, "Manager", "Approves or rejects requests")

    System(examplehr, "Time-Off Microservice", "Manages request lifecycle and balance cache (NestJS + SQLite)")

    System_Ext(hcm, "HCM System", "Workday / SAP — source of truth for leave balances")
    System_Ext(gateway, "API Gateway", "Handles auth, routing, rate limiting")

    Rel(employee, gateway, "REST calls", "HTTPS")
    Rel(manager, gateway, "REST calls", "HTTPS")
    Rel(gateway, examplehr, "Forwards requests", "HTTP")
    Rel(examplehr, hcm, "Deduct / restore balance", "REST / HTTPS")
    Rel(hcm, examplehr, "Push balance updates (realtime + batch)", "REST webhook / HTTPS")
```

---

## 2. Component Diagram

```mermaid
graph TB
    subgraph ExampleHR Time-Off Microservice
        RC[RequestsController\nPATCH approve/reject/cancel\nPOST submit\nGET list/get]
        BC[BalancesController\nGET balance]
        SC[HcmSyncController\nPOST realtime\nPOST batch]

        RS[TimeOffRequestsService\nState machine\nOrchestrates approval flow]
        BS[BalancesService\nDefensive check\nOptimistic lock write]
        SS[HcmSyncService\nUpsert balance\nReconciliation]
        HA[HcmAdapterService\nHTTP client wrapper\nTimeout + error mapping]

        DB[(SQLite DB\nbalances\ntime_off_requests\nsync_log)]

        RC --> RS
        BC --> BS
        SC --> SS
        RS --> BS
        RS --> HA
        SS --> BS
        BS --> DB
        RS --> DB
        SS --> DB
    end

    HA -->|Deduct / Restore| HCM[HCM System]
    HCM -->|Webhook| SC
```

---

## 3. Request Approval Sequence

```mermaid
sequenceDiagram
    participant M as Manager
    participant API as TimeOffRequestsService
    participant BS as BalancesService
    participant DB as SQLite
    participant HCM as HCM System

    M->>API: PATCH /time-off-requests/:id/approve

    API->>DB: Fetch request (status must be PENDING)
    DB-->>API: TimeOffRequest

    API->>BS: defensiveCheck(employeeId, locationId, days)
    BS->>DB: SELECT balance WHERE employee_id=? AND location_id=?
    DB-->>BS: Balance{available, version}

    alt available < days
        BS-->>API: InsufficientBalanceException
        API-->>M: 422 INSUFFICIENT_BALANCE
    else available >= days
        BS-->>API: OK

        API->>HCM: POST /hcm/deduct {employeeId, locationId, days}

        alt HCM returns error
            HCM-->>API: 4xx HCM error
            API-->>M: 422 HCM_REJECTION
        else HCM timeout / 5xx
            HCM-->>API: timeout / 5xx
            API-->>M: 503 HCM_UNAVAILABLE
        else HCM success
            HCM-->>API: 200 {newAvailable, newUsed}

            API->>DB: BEGIN TRANSACTION
            API->>DB: UPDATE balances SET available=?, used=?, version=version+1\nWHERE employee_id=? AND location_id=? AND version=?
            API->>DB: UPDATE time_off_requests SET status='APPROVED' WHERE id=?
            API->>DB: INSERT INTO sync_log (source='request_approve', ...)
            API->>DB: COMMIT

            alt Optimistic lock conflict (0 rows updated)
                API->>API: Retry once (re-fetch balance, re-check)
                alt Still failing
                    API-->>M: 409 CONFLICT
                end
            else Write success
                API-->>M: 200 OK {request}
            end
        end
    end
```

---

## 4. HCM Real-Time Webhook Flow

```mermaid
sequenceDiagram
    participant HCM as HCM System
    participant SC as HcmSyncController
    participant SS as HcmSyncService
    participant DB as SQLite

    HCM->>SC: POST /hcm/sync/realtime\n{employeeId, locationId, available, used, total}

    SC->>SS: handleRealtimeUpdate(dto)
    SS->>DB: UPSERT balances ON CONFLICT (employee_id, location_id)\nDO UPDATE SET available=?, used=?, total=?, version=version+1, last_synced_at=NOW()
    SS->>DB: INSERT INTO sync_log (source='realtime_webhook', ...)

    SS->>DB: SELECT time_off_requests WHERE status IN ('PENDING')\nAND employee_id=? AND location_id=? AND days > ?newAvailable
    DB-->>SS: [invalidated requests]

    loop For each invalidated request
        SS->>DB: UPDATE time_off_requests SET status='INVALIDATED'
        SS->>DB: INSERT INTO sync_log (source='invalidation', ...)
    end

    SS-->>SC: {updated: 1, invalidated: N}
    SC-->>HCM: 200 OK
```

---

## 5. HCM Batch Sync Flow

```mermaid
sequenceDiagram
    participant HCM as HCM System
    participant SC as HcmSyncController
    participant SS as HcmSyncService
    participant DB as SQLite

    HCM->>SC: POST /hcm/sync/batch\n{balances: [{employeeId, locationId, available, used, total}, ...]}

    SC->>SS: handleBatchSync(dto)

    SS->>DB: BEGIN TRANSACTION
    loop For each balance record
        SS->>DB: UPSERT balances ON CONFLICT DO UPDATE\n(with version increment and last_synced_at)
        SS->>DB: INSERT INTO sync_log (source='batch', ...)
    end
    SS->>DB: COMMIT

    Note over SS,DB: Reconciliation pass
    SS->>DB: SELECT requests where status IN ('PENDING','APPROVED')\nAND days > updated available balance
    DB-->>SS: [invalidated requests]

    loop For each invalidated request
        SS->>DB: UPDATE time_off_requests SET status='INVALIDATED'
    end

    SS-->>SC: {updated: N, invalidated: M}
    SC-->>HCM: 200 OK {updated: N, invalidated: M}
```

---

## 6. Request Status State Machine

```mermaid
stateDiagram-v2
    [*] --> PENDING : POST /time-off-requests

    PENDING --> APPROVED : PATCH approve\n(HCM deduct succeeds)
    PENDING --> REJECTED : PATCH reject
    PENDING --> INVALIDATED : Batch/realtime sync\nlowers balance below request.days

    APPROVED --> CANCELLED : PATCH cancel\n(HCM restore succeeds)
    APPROVED --> INVALIDATED : Batch/realtime sync\nlowers balance below request.days

    REJECTED --> [*]
    CANCELLED --> [*]
    INVALIDATED --> [*]
```

---

## 7. Circuit Breaker State Machine (HcmAdapterService)

```mermaid
stateDiagram-v2
    [*] --> CLOSED : Service start

    CLOSED --> OPEN : Error rate ≥ 50%\nover 10 calls
    CLOSED --> CLOSED : Successful call

    OPEN --> HALF_OPEN : After 30s reset timeout
    OPEN --> OPEN : Any call → fail fast\n(HcmUnavailableException)

    HALF_OPEN --> CLOSED : Probe call succeeds
    HALF_OPEN --> OPEN : Probe call fails
```

---

## 8. Health Check Component

```mermaid
graph LR
    LB[Load Balancer\nor k8s probe] -->|GET /health| HC[HealthController]
    HC --> DB_CHK[TypeOrmHealthIndicator\nSELECT 1]
    HC --> HCM_CHK[HttpHealthIndicator\nHCM /health ping\n3s timeout]

    DB_CHK -->|up| OK[status: ok\nHTTP 200]
    DB_CHK -->|down| DOWN[status: down\nHTTP 503]
    HCM_CHK -->|up| OK
    HCM_CHK -->|down| DEG[status: degraded\nHTTP 200\nReads work, writes → 503]
```

---

## 9. Graceful Shutdown Sequence

```mermaid
sequenceDiagram
    participant OS as OS / Orchestrator
    participant App as NestJS App
    participant HTTP as HTTP Server
    participant DB as TypeORM / SQLite

    OS->>App: SIGTERM

    App->>HTTP: Stop accepting new connections
    Note over HTTP: In-flight requests continue

    App->>App: Wait for in-flight requests\n(30s grace window)

    alt All requests complete within 30s
        App->>DB: DataSource.destroy()
        DB-->>App: Connection closed
        App->>OS: exit(0)
    else Grace period expires
        App->>OS: exit(1) — force exit
    end
```
