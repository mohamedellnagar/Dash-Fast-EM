# Sync Architecture — Durable Near-Real-Time Platform

This document describes the durable synchronization platform added in Phase 3
(see [`PHASE_3_IMPLEMENTATION.md`](./PHASE_3_IMPLEMENTATION.md)). The existing
Express + Prisma + EJS + JSON-API architecture was **not replaced** — Phase 3
adds a database-backed queue and control/observability layers on top of it.

The platform keeps the dashboard's view of every FastTest registration fresh
(status → results) through backend-only polling, without ever asking a browser
or a dashboard user to talk to FastTest.

---

## Core invariant: the frontend never calls FastTest

> **All FastTest traffic originates from the backend worker pool.** The frontend
> never calls FastTest directly, and dashboard users never multiply FastTest
> traffic. A page load, a filter, a refresh, or 100 concurrent viewers all read
> from the local database. FastTest is polled on a schedule the platform
> controls, capped by per-workspace and global rate limits — independent of how
> many humans are looking at the dashboard.

This is what makes the system safe to scale horizontally: adding dashboard users
adds read load on Postgres/SQLite, not on FastTest.

---

## Why a database-backed queue (no Redis)

The queue is a **durable, database-backed queue with atomic row-claim locking**.
There is no Redis, no external broker, and no new infrastructure. The single
Prisma-managed database (SQLite in dev, PostgreSQL in prod) is the source of
truth for jobs, locks, rate config, and controls.

Every required queue capability is satisfied by the DB design:

| Capability | How it is met |
|---|---|
| **Persistence** | Jobs live in the `SyncJob` table; nothing is lost on worker restart/crash. |
| **Priorities** | `priority` column (lower = higher); claim orders by `priority ASC, scheduledAt ASC`. |
| **Scheduled / delayed execution** | `scheduledAt` (QUEUED) and `nextRetryAt` (RETRY_SCHEDULED) gate when a job becomes claimable. |
| **Retries** | Failed jobs move to `RETRY_SCHEDULED` with a future `nextRetryAt` (backoff + jitter). |
| **Dedup** | `dedupeKey` — enqueue returns the existing ACTIVE job instead of creating a duplicate. |
| **Dead-letter** | Exhausted / permanently-failed jobs move to `DEAD_LETTER`. |
| **Distributed locking** | Guarded `updateMany` claim + separate `DistributedLock` table. |
| **Stalled recovery** | RUNNING jobs whose heartbeat expired are reclaimed to `RETRY_SCHEDULED`. |

**Portability.** Because the design uses only ordinary rows, indexes, and guarded
conditional updates, it runs **identically on SQLite and PostgreSQL** with no code
change. On Postgres the row-claim can additionally be hardened with
`pg_advisory_xact_lock`; the portable table-based approach is the default.

### Atomic row-claim

A worker claims a job with a **guarded `updateMany`**:

```
UPDATE SyncJob
SET status='RUNNING', lockedBy=?, lockedAt=now, heartbeatAt=now,
    startedAt=now, attemptCount = attemptCount + 1
WHERE id=? AND status=<expected> AND lockedBy IS NULL
```

Exactly one worker's update returns `count === 1`; every other racing worker sees
`count === 0` and moves on. No transactions-across-services, no broker, no lost
jobs. (`src/services/sync/queue.service.ts` → `claimNext`.)

---

## Distributed lock design (`DistributedLock`)

For general mutual exclusion that is *not* a job claim — most importantly
**per-workspace token refresh** — the platform uses the `DistributedLock` table
(`src/services/sync/lock.service.ts`).

```prisma
model DistributedLock {
  key         String   @id   // e.g. "token:<workspaceId>"
  owner       String
  acquiredAt  DateTime
  heartbeatAt DateTime
  expiresAt   DateTime
  @@index([expiresAt])
}
```

Correctness properties:

- **Fresh acquisition** is an atomic unique `INSERT` on the primary key `key`.
  Only one caller can win a brand-new lock.
- **Takeover of an expired lock** is a guarded `updateMany` (`WHERE key=? AND
  expiresAt < now`) **followed by read-after-write owner verification** — the
  persisted `owner` is authoritative, which resolves the concurrent-takeover
  race (two workers may both update; only the one whose write survived owns it).
- **Heartbeat / renewal**: long operations call `renewLock` on an interval
  (`withLock` auto-renews every `ttl/2`) so a live holder is never stolen
  mid-flight.
- **Crash recovery**: a crashed holder's lock is reclaimable once `expiresAt`
  passes; `reapExpiredLocks` sweeps stale rows.

> On PostgreSQL this can be further hardened with `pg_advisory_xact_lock`; the
> table approach is the portable default that works on SQLite too.

API: `acquireLock`, `renewLock`, `releaseLock`, `withLock(key, owner, ttl, fn)`,
`reapExpiredLocks`.

---

## The 12 job types

Defined in `src/lib/enums.ts` (`JOB_TYPE`), dispatched in
`src/services/sync/handlers.ts` (`runJob`). Each handler is a **single-attempt
primitive** — it performs the work once and returns an outcome; the queue owns
all retry/dead-letter logic.

| # | Job type | Role | Default priority |
|---|---|---|---|
| 1 | `MANUAL_SYNC` | Operator-triggered full sync (status + results) of one registration. | 10 |
| 2 | `AUTHENTICATE_WORKSPACE` | Authenticate a workspace / refresh its token. | 20 |
| 3 | `SYNC_ACTIVE_EXAMS` | Fan out status jobs for registrations whose exam window is open now. | 30 |
| 4 | `SYNC_REGISTRATION_RESULTS` | Fetch + persist results for one registration. | 40 |
| 5 | `SYNC_REGISTRATION_FULL` | Status then, if needed, results — for one registration. | 45 |
| 6 | `SYNC_REGISTRATION_STATUS` | Fetch + persist status for one registration. | 50 |
| 7 | `RETRY_FAILED_SYNC` | Requeue FAILED/DEAD_LETTER jobs (optionally per workspace). | 60 |
| 8 | `SYNC_WORKSPACE_BATCH` | Fan out status jobs for every registration in a workspace. | 70 |
| 9 | `SYNC_SCHOOL_BATCH` | Fan out status jobs for every registration in a school. | 70 |
| 10 | `SYNC_SUBJECT_BATCH` | Fan out status jobs for every registration of a subject. | 70 |
| 11 | `REFRESH_ATTENTION_ITEMS` | Recompute the students-requiring-attention queue. | 80 |
| 12 | `REFRESH_ANALYTICS_CACHE` | Invalidate/refresh analytics caches. | 90 |

**Batch jobs never call FastTest directly** — they enqueue child
`SYNC_REGISTRATION_STATUS` jobs (deduped), so a batch is just a fan-out that
respects the same rate limits as individual syncs.

Priorities come from `JOB_PRIORITY` in `src/lib/enums.ts` (lower value = claimed
first). An explicit `priority` on enqueue overrides the per-type default.

---

## The 15-state sync-state machine

Every `ExamRegistration` carries a formal `syncState` (`SYNC_STATE` in
`src/lib/enums.ts`). Transitions are validated by `canTransition` in
`src/lib/sync-state.ts`; invalid transitions are logged and skipped (state left
unchanged), and every accepted transition is persisted to `SyncStateTransition`
(`src/services/sync/state.ts`).

The 15 states:

| State | Meaning |
|---|---|
| `PENDING` | Newly imported; not yet scheduled. |
| `QUEUED` | Scheduled / bridged; about to sync. |
| `SYNCING_STATUS` | Status fetch in progress. |
| `STATUS_SYNCED` | Status fetch succeeded. |
| `SYNCING_RESULTS` | Results fetch in progress. |
| `RESULTS_SYNCED` | Results fetch succeeded. |
| `COMPLETED` | Terminal — synced through to results. |
| `NOT_FOUND` | FastTest returned not-found. |
| `AUTH_FAILED` | Authentication / token failure. |
| `API_ERROR` | Generic upstream API error. |
| `TIMEOUT` | Upstream request timed out. |
| `RATE_LIMITED` | Throttled by rate limiter / upstream 429. |
| `RETRY_SCHEDULED` | Awaiting a scheduled retry. |
| `MANUAL_REVIEW` | Terminal — needs an operator. |
| `STALE` | Data older than its freshness window. |

Terminal states: `COMPLETED` and `MANUAL_REVIEW` (`TERMINAL_SYNC_STATES`). Note
that even terminal states allow `→ QUEUED` for a fresh poll cycle (e.g. a
completed exam re-opened, or an operator re-queuing a manual-review item). A
self-transition (`from === to`) is always allowed (idempotent).

### Allowed transitions

```
PENDING          → QUEUED, MANUAL_REVIEW, STALE
QUEUED           → SYNCING_STATUS, SYNCING_RESULTS, MANUAL_REVIEW, RATE_LIMITED,
                   RETRY_SCHEDULED, STALE
SYNCING_STATUS   → STATUS_SYNCED, NOT_FOUND, AUTH_FAILED, API_ERROR, TIMEOUT,
                   RATE_LIMITED, RETRY_SCHEDULED, MANUAL_REVIEW
STATUS_SYNCED    → SYNCING_RESULTS, COMPLETED, QUEUED, STALE
SYNCING_RESULTS  → RESULTS_SYNCED, NOT_FOUND, AUTH_FAILED, API_ERROR, TIMEOUT,
                   RATE_LIMITED, RETRY_SCHEDULED, MANUAL_REVIEW
RESULTS_SYNCED   → COMPLETED, QUEUED, STALE
COMPLETED        → QUEUED, STALE                (may re-poll, e.g. re-open)
NOT_FOUND        → QUEUED, RETRY_SCHEDULED, MANUAL_REVIEW
AUTH_FAILED      → QUEUED, RETRY_SCHEDULED, MANUAL_REVIEW
API_ERROR        → QUEUED, RETRY_SCHEDULED, MANUAL_REVIEW
TIMEOUT          → QUEUED, RETRY_SCHEDULED, MANUAL_REVIEW
RATE_LIMITED     → QUEUED, RETRY_SCHEDULED
RETRY_SCHEDULED  → QUEUED, SYNCING_STATUS, SYNCING_RESULTS, MANUAL_REVIEW
MANUAL_REVIEW    → QUEUED                       (operator re-queues)
STALE            → QUEUED, MANUAL_REVIEW
```

The happy path is:

```
PENDING → QUEUED → SYNCING_STATUS → STATUS_SYNCED
        → SYNCING_RESULTS → RESULTS_SYNCED → COMPLETED
```

---

## Smart polling scheduler

`computeScheduling` (`src/services/sync/scheduler.service.ts`) decides, per
registration, *when* and *how urgently* to poll, and whether the data is stale.
It returns:

| Field | Meaning |
|---|---|
| `nextSyncAt` | When the registration next becomes due. |
| `syncPriority` | Queue priority derived from dashboard status (and exam window). |
| `isActiveExamWindow` | `now ∈ [startDate, endDate]`. |
| `requiresStatusFetch` | True unless already `COMPLETED` **with results** — this is what "stops frequent polling once completed with results". |
| `requiresResultsFetch` | `shouldFetchResults(status) && !hasResults` (fetch results once). |
| `isStale`, `staleReason`, `staleSeverity` | Freshness overdue relative to expected interval. |

### Poll intervals (`src/services/sync/policy.ts`)

`nextSyncDelaySeconds(status, inActiveWindow)` maps status → cadence:

| Status | Interval |
|---|---|
| `NOT_STARTED` (before window) | 600 s (10 min) |
| `NOT_STARTED` (active window) | 120 s (2 min) |
| `IN_PROGRESS` | 45 s |
| `UNDER_REVIEW` | 300 s (5 min) |
| `REVIEW_FAILED` | 900 s (15 min) |
| `COMPLETED` | 86400 s (fetch results once, then back off to daily) |
| `UNKNOWN` | 600 s |

Once a registration is `COMPLETED` **and has results**, `requiresStatusFetch`
becomes false and the cadence backs off to daily — the platform stops burning
FastTest calls on work that is done.

### Staleness

For anything not completed-with-results, `computeScheduling` flags:

- **HIGH** — no successful sync during an active exam window (`sinceOk > 3× expected`).
- **HIGH/MEDIUM** — sync overdue (`now − nextSyncAt > 5× expected`; HIGH if active).
- **LOW** — data older than freshness window (`sinceOk > 6× expected`).

`refreshStaleFlags` recomputes these periodically and preserves `staleSince`.

### Enqueueing due jobs + fair/batch scheduling

`enqueueDueJobs` selects registrations that are due (`nextSyncAt` null or past),
in **sync-enabled, active, non-paused** workspaces, not in `MANUAL_REVIEW`,
ordered by `syncPriority ASC, nextSyncAt ASC`, up to a limit (default 500). For
each it enqueues `SYNC_REGISTRATION_FULL` / `_RESULTS` / `_STATUS` (whichever the
scheduling requires) and advances `nextSyncAt` so it is not re-enqueued every
tick. **Enqueue is idempotent via dedup**, so running the scheduler on multiple
workers is safe — no leader election is required for correctness.

**Fair scheduling at claim time**: `claimNext` groups RUNNING jobs by workspace
and prefers candidates from workspaces with *fewer* running jobs, so one busy
workspace cannot starve the others.

---

## The worker loop (`src/workers/sync.worker.ts`)

Each worker process:

1. **Registers** a `WorkerInstance` and runs a **heartbeat loop**
   (`WORKER_HEARTBEAT_MS`, default 10 s) so its health is visible.
2. Runs a **bounded pool of job runners** (`SYNC_WORKER_CONCURRENCY`, default 4).
   Each runner loops: `claimNext` → `runJob` → finalize
   (`completeJob` / `failJob` / reschedule). While a job runs, a **per-job
   heartbeat** keeps `heartbeatAt` fresh so it is not mistaken for stalled.
3. Runs an **orchestrator loop** that periodically:
   - ticks the scheduler (`enqueueDueJobs` + `recoverStalledJobs` +
     `reapExpiredLocks` + worker-health reconcile) every
     `SCHEDULER_INTERVAL_MS` (default 30 s);
   - refreshes stale flags (every 5 min);
   - captures snapshots + runs alert detectors (every 1 min);
   - runs retention (every 6 h).
4. **Graceful shutdown** (SIGTERM/SIGINT): stops claiming new jobs and drains
   in-flight runners before marking the worker stopped and disconnecting.
5. **Stalled recovery**: `recoverStalledJobs` moves RUNNING jobs whose heartbeat
   is older than `SYNC_STALLED_JOB_MS` (default 120 s) back to `RETRY_SCHEDULED`
   with `lastErrorCode = STALLED`, so a crashed worker's jobs are reclaimed.

Because scheduling is idempotent, **every worker can run the orchestrator
safely** — horizontal scaling is just "run more worker processes".

---

## Data flow

```
                     ┌─────────────────────────────────────────────┐
                     │  Orchestrator (every worker, idempotent)     │
                     │  enqueueDueJobs → computeScheduling / policy  │
                     └───────────────────────┬─────────────────────┘
                                             │ enqueue (dedup on dedupeKey)
                                             ▼
        Operator (/sync, /admin/queue) ─► ┌───────────────────┐
        MANUAL_SYNC / batch / retry       │   SyncJob table    │  status:
                                          │  (durable queue)   │  QUEUED / RETRY_SCHEDULED
                                          └─────────┬─────────┘
                                                    │  claimNext:
                                                    │  guarded updateMany
                                                    │  (priority, fairness,
                                                    │   pause, per-ws + global
                                                    │   concurrency, circuit)
                                                    ▼
                                          ┌───────────────────┐
                                          │  Worker runner     │  status: RUNNING
                                          │  runJob → handler  │  + heartbeat
                                          └─────────┬─────────┘
                                                    │  rate-limit gate
                                                    │  (token bucket × throttle)
                                                    ▼
                                          ┌───────────────────┐
                                          │  FastTest API      │  (backend only)
                                          │  status / results  │
                                          └─────────┬─────────┘
                                                    │ outcome
                    ┌───────────────────────────────┼───────────────────────────────┐
                    ▼                               ▼                                 ▼
              DONE                             FAIL (classify)                   RESCHEDULE
        completeJob → DONE            decideRetry (retry.ts)               nextRetryAt = now+delay
        + SyncJobAttempt          ┌────────────┬──────────────┐           (rate-limited, decrement
        + transitionState         ▼            ▼              ▼            attempt) → RETRY_SCHEDULED
        → STATUS/RESULTS_SYNCED  RETRY      DEAD_LETTER   MANUAL_REVIEW
        → COMPLETED           (backoff+     (terminal)    (terminal)
                               jitter →
                               RETRY_SCHEDULED)
```

Stalled RUNNING jobs (heartbeat expired) are swept back to `RETRY_SCHEDULED` by
`recoverStalledJobs` and re-enter the claim loop.

---

## Related documents

- [`PHASE_3_IMPLEMENTATION.md`](./PHASE_3_IMPLEMENTATION.md) — what was built (source of truth).
- [`QUEUE_OPERATIONS.md`](./QUEUE_OPERATIONS.md) — operating the queue.
- [`RATE_LIMITING.md`](./RATE_LIMITING.md) — workspace-aware rate limiting.
