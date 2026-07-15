# Queue Operations

How to operate the durable sync queue: job lifecycle, the monitoring dashboards,
the operator actions and their permissions, retry/dead-letter/stalled handling,
and example API calls. See [`SYNC_ARCHITECTURE.md`](./SYNC_ARCHITECTURE.md) for
the design, and [`RATE_LIMITING.md`](./RATE_LIMITING.md) for throttling.

All operational actions are **permission-gated and audited** (`audit(...)` in
`src/routes/sync-admin.routes.ts` and `sync-control.routes.ts`).

---

## Job lifecycle & statuses

A `SyncJob` moves through these statuses (`JOB_STATUS` in `src/lib/enums.ts`):

| Status | Meaning | Claimable? | Terminal? |
|---|---|---|---|
| `QUEUED` | Waiting; claimable once `scheduledAt ≤ now`. | Yes | No |
| `RUNNING` | Claimed by a worker; heartbeating. | No | No |
| `RETRY_SCHEDULED` | Awaiting retry; claimable once `nextRetryAt ≤ now`. | Yes | No |
| `DONE` | Completed successfully. | No | **Yes** |
| `FAILED` | Failed (legacy/manual state; requeuable via retry-failed). | No | No |
| `DEAD_LETTER` | Exhausted retries / permanently failed. | No | **Yes** |
| `CANCELLED` | Cancelled by an operator. | No | **Yes** |
| `MANUAL_REVIEW` | Needs a human (e.g. auth exhausted, workspace mismatch). | No | **Yes** |

Terminal statuses (`TERMINAL_JOB_STATUSES`) are never re-processed:
`DONE`, `DEAD_LETTER`, `CANCELLED`, `MANUAL_REVIEW`.

```
QUEUED ──claim──► RUNNING ──success──► DONE
   ▲                 │
   │                 ├─fail→ RETRY ──► RETRY_SCHEDULED ──(nextRetryAt)──► (claim) RUNNING
   │                 ├─fail→ exhausted / permanent ──► DEAD_LETTER
   │                 ├─fail→ auth-exhausted / mismatch ──► MANUAL_REVIEW
   │                 └─stalled (heartbeat expired) ──► RETRY_SCHEDULED
   └── retry / retry-failed / requeue-deadletter (operator) ──┘

any non-terminal ──cancel──► CANCELLED
```

Each attempt is recorded in `SyncJobAttempt` (worker, endpoint, status,
error category/code, HTTP status, duration, correlation id) — this is the
audit trail behind **Sync History** (`/admin/sync-history`).

---

## Enqueue & dedup semantics

`enqueue(input)` (`src/services/sync/queue.service.ts`):

- If a `dedupeKey` (explicit, or the default) matches an **ACTIVE** job
  (`QUEUED`, `RUNNING`, or `RETRY_SCHEDULED`), the **existing job is returned**
  and `deduped: true` — no duplicate is created (idempotent enqueue). This is
  what makes multi-worker scheduling safe.
- Default dedupe key:
  - `"<jobType>:<registrationId>"` when a registration id is present;
  - `"<jobType>:<workspaceId>"` for workspace-scoped job types;
  - otherwise none (no dedup).
- Priority defaults to `JOB_PRIORITY[jobType]` (or 100), `maxAttempts` to
  `SYNC_MAX_RETRIES` (default 3), `scheduledAt` to now.
- **Payloads must never contain secrets** — only ids/keys.

---

## Priorities (`JOB_PRIORITY`)

Lower value = claimed first. Claim order is `priority ASC, scheduledAt ASC`.

| Job type | Priority |
|---|---|
| `MANUAL_SYNC` | 10 |
| `AUTHENTICATE_WORKSPACE` | 20 |
| `SYNC_ACTIVE_EXAMS` | 30 |
| `SYNC_REGISTRATION_RESULTS` | 40 |
| `SYNC_REGISTRATION_FULL` | 45 |
| `SYNC_REGISTRATION_STATUS` | 50 |
| `RETRY_FAILED_SYNC` | 60 |
| `SYNC_WORKSPACE_BATCH` / `SYNC_SCHOOL_BATCH` / `SYNC_SUBJECT_BATCH` | 70 |
| `REFRESH_ATTENTION_ITEMS` | 80 |
| `REFRESH_ANALYTICS_CACHE` | 90 |

The scheduler may also assign a per-registration `syncPriority` (e.g. 30 for
`IN_PROGRESS`, 35 for a not-started registration in an active window) which is
passed as the job priority for that registration's sync.

---

## Queue Monitoring dashboard (`/admin/queue`)

Requires `queue:view`. Backed by `queueStats()` plus recent snapshots, workers,
dead-letter and failed tables.

**KPIs** (from `queueStats`): queued, running, completed (DONE), failed,
retry-scheduled, dead-letter counts; oldest-queued age; jobs and failures in the
last minute; healthy worker count.

**Charts**: queue-depth-over-time (from `QueueMetricSnapshot`), jobs by type, by
workspace, and by priority.

**Tables**: dead-letter jobs (latest 50) and recent FAILED / MANUAL_REVIEW jobs
(latest 50).

### Actions and required permissions

| Action | Route | Permission |
|---|---|---|
| View queue dashboard / stats | `GET /admin/queue`, `GET /api/queue/stats` | `queue:view` |
| Retry a job | `POST /api/queue/jobs/:id/retry` | `sync:retry` |
| Cancel a job | `POST /api/queue/jobs/:id/cancel` | `sync:cancel` |
| Retry all failed | `POST /api/queue/retry-failed` | `sync:retry` |
| Requeue a dead-letter job | `POST /api/queue/jobs/:id/requeue` | `sync:admin` |
| Pause / resume a **workspace** | `POST /api/queue/workspaces/:id/pause` | `workspace:pause` |
| Pause / resume a **job type** | `POST /api/queue/job-types/:jobType/pause` | `queue:manage` |

- **Retry** (`retryJob`) resets a job to `QUEUED` with `attemptCount = 0`,
  clears `nextRetryAt` / lock / `completedAt`, schedules it now.
- **Retry all failed** (`retryFailedJobs`) requeues every `FAILED` /
  `DEAD_LETTER` job (optionally filtered by `workspaceId` / `jobType`) and
  returns the count.
- **Requeue dead-letter** (`requeueDeadLetter`) requeues a single
  `DEAD_LETTER` job (delegates to retry).
- **Pause workspace** writes a `QueueControl(scope=WORKSPACE)` row **and** sets
  `FastTestWorkspace.syncPaused=true`; paused workspaces are skipped both at
  scheduling (`enqueueDueJobs`) and at claim time (`claimNext`).
- **Pause job type** writes a `QueueControl(scope=JOB_TYPE)` row; paused job
  types are skipped at claim time.

---

## Sync Control Center (`/sync`)

Requires `sync:view` to view; `sync:bulk` to act. An operations-focused,
registration-level view (`src/routes/sync-control.routes.ts`).

**Filters**: standard registration filters (subject, school, workspace,
dashboard status, sync state, next/last sync, stale), respecting the user's
school scope. Each listed registration shows its latest **active** queue job.

**Bulk actions** on selected registrations (`POST /api/sync/bulk`, `sync:bulk`):

| Action | Effect |
|---|---|
| `SYNC` | Enqueue a `MANUAL_SYNC` (priority 10) per registration. |
| `CANCEL` | Cancel that registration's active (`QUEUED` / `RETRY_SCHEDULED`) jobs. |
| `MANUAL_REVIEW` | Transition sync state to `MANUAL_REVIEW`, clear `nextSyncAt`. |

- **Hard cap of 500** selected registrations (`MAX_SELECTION = 500`) — there is
  **no unrestricted bulk sync**. A larger selection is rejected `400`. The UI
  should show a **confirmation** before firing a bulk action.
- Selections are re-filtered server-side to the user's **school scope** — a user
  can only act on registrations they are permitted to see.

**Batch by workspace / school / subject** (each `sync:bulk`, deduped, audited):

| Route | Job |
|---|---|
| `POST /api/sync/workspace/:id` | `SYNC_WORKSPACE_BATCH` (priority 70) |
| `POST /api/sync/school/:id` | `SYNC_SCHOOL_BATCH` (priority 70) |
| `POST /api/sync/subject` | `SYNC_SUBJECT_BATCH` (priority 70) |

Batch jobs fan out child `SYNC_REGISTRATION_STATUS` jobs (deduped) rather than
calling FastTest directly.

---

## Retry strategy & backoff (`src/services/sync/retry.ts`)

On failure, the worker classifies the error and `decideRetry(category, attempt,
maxAttempts)` picks an action:

| Error category | Decision |
|---|---|
| `INVALID_TEST_CODE` | `DEAD_LETTER` immediately (permanent). |
| `WORKSPACE_MISMATCH` | `MANUAL_REVIEW` immediately (permanent). |
| `NOT_FOUND` | Limited retries (≤ `min(maxAttempts, 2)`), then `MANUAL_REVIEW`. |
| `AUTHENTICATION` (attempts exhausted) | `MANUAL_REVIEW`. |
| Other categories (attempts exhausted) | `DEAD_LETTER`. |
| `RATE_LIMIT` | `RETRY`, honoring upstream `Retry-After` if present, else backoff. |
| Transient (`TIMEOUT`, `NETWORK`, `FASTTEST_INTERNAL_ERROR`, …) | `RETRY` with backoff. |

**Backoff with full jitter** (`backoffMs`): base schedule `0s → 30s → 120s`, then
exponential `120s × 2ⁿ` capped at **15 min**. Actual delay is randomized in
`[base/2, base]` (full jitter) to avoid synchronized retry storms across workers.
A `RETRY` sets `status = RETRY_SCHEDULED` and `nextRetryAt = now + delay`; the job
becomes claimable again once that time passes.

> Rate-limit *reschedules* (the worker couldn't get a token) also use
> `RETRY_SCHEDULED` but **decrement** `attemptCount` so being throttled does not
> consume a real retry budget.

---

## Dead-letter handling

- A `DEAD_LETTER` job is terminal and never re-processed automatically.
- It surfaces in the **Queue Monitoring** dead-letter table and drives the
  `DEAD_LETTER_JOBS` alert.
- Operators requeue it via `POST /api/queue/jobs/:id/requeue` (`sync:admin`) or
  in bulk via **retry all failed**.

---

## Stalled-job recovery

`recoverStalledJobs` (run each scheduler tick) moves any `RUNNING` job whose
`heartbeatAt` is older than `SYNC_STALLED_JOB_MS` (default 120 s) — or that has
no heartbeat and a stale `lockedAt` — back to `RETRY_SCHEDULED` with
`lastErrorCode = STALLED`. This reclaims jobs orphaned by a crashed or hung
worker. Expired `DistributedLock` rows are similarly reaped
(`reapExpiredLocks`).

---

## Example API calls

All endpoints require an authenticated session with the listed permission.

```bash
# Queue KPIs (queue:view)
curl -s https://dash.example/api/queue/stats \
  -H "Cookie: $SESSION"

# Retry one job (sync:retry)
curl -X POST https://dash.example/api/queue/jobs/JOB_ID/retry \
  -H "Cookie: $SESSION"

# Cancel one job (sync:cancel)
curl -X POST https://dash.example/api/queue/jobs/JOB_ID/cancel \
  -H "Cookie: $SESSION"

# Retry all failed for a workspace (sync:retry)
curl -X POST https://dash.example/api/queue/retry-failed \
  -H "Cookie: $SESSION" -H "Content-Type: application/json" \
  -d '{"workspaceId":"WS_ID"}'

# Requeue a dead-letter job (sync:admin)
curl -X POST https://dash.example/api/queue/jobs/JOB_ID/requeue \
  -H "Cookie: $SESSION"

# Pause a workspace (workspace:pause)
curl -X POST https://dash.example/api/queue/workspaces/WS_ID/pause \
  -H "Cookie: $SESSION" -H "Content-Type: application/json" \
  -d '{"paused":true}'

# Pause a job type (queue:manage)
curl -X POST https://dash.example/api/queue/job-types/SYNC_REGISTRATION_STATUS/pause \
  -H "Cookie: $SESSION" -H "Content-Type: application/json" \
  -d '{"paused":true}'

# Bulk sync selected registrations, max 500 (sync:bulk)
curl -X POST https://dash.example/api/sync/bulk \
  -H "Cookie: $SESSION" -H "Content-Type: application/json" \
  -d '{"action":"SYNC","registrationIds":["r1","r2"]}'

# Batch a whole workspace (sync:bulk)
curl -X POST https://dash.example/api/sync/workspace/WS_ID \
  -H "Cookie: $SESSION"
```

Every one of these actions writes an audit record (actor, IP, action, entity).
