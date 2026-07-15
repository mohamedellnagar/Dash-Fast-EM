# Worker Operations

The sync platform runs on a fleet of **durable-queue worker processes**. Each
worker registers itself, heartbeats, runs a bounded pool of job runners plus a
periodic orchestrator loop, and drains gracefully on shutdown. Workers scale
horizontally with **no leader election** — every worker claims jobs atomically.

- Worker entrypoint: `src/workers/sync.worker.ts`
- Registry / health: `src/services/sync/worker-registry.service.ts`
- Models: `WorkerInstance`, `WorkerHeartbeat` (`prisma/schema.prisma`)
- Status enum: `WORKER_STATUS` in `src/lib/enums.ts`

---

## Worker ID format

Each process generates a unique id at startup:

```ts
export const WORKER_ID = `worker-${os.hostname()}-${process.pid}-${uuid().slice(0, 6)}`;
// e.g. worker-web-7c9f2a-1-a1b2c3
```

Format: `worker-<hostname>-<pid>-<rand6>`. The random suffix guarantees
uniqueness even if two processes share a host and PID namespace (e.g. containers).
The id is the primary key of the `WorkerInstance` row.

---

## Registration & heartbeat

| Step | Function | Effect |
|---|---|---|
| Startup | `registerWorker(WORKER_ID)` | Upserts a `WorkerInstance` row: `hostname`, `pid`, `version` (`0.3.0`), `status = HEALTHY`, fresh `startedAt`/`lastHeartbeatAt`, clears `stoppedAt`. |
| Every `WORKER_HEARTBEAT_MS` | `heartbeat(WORKER_ID, runtime)` | Updates the row with `lastHeartbeatAt`, live counters (`currentJobs`, `jobsCompleted`, `jobsFailed`, `avgJobDurationMs`), and `memoryMb` (RSS). Also inserts a `WorkerHeartbeat` history row. |
| Shutdown | `markStopped(WORKER_ID)` | Sets `status = OFFLINE`, `stoppedAt = now`, `currentJobs = 0`. |

The heartbeat is a `setInterval` at `env.sync.heartbeatMs` (default 10s).
Individual **jobs** also heartbeat while running (`heartbeatJob`) so long jobs
are not mistaken for stalled — see stalled-job recovery below.

---

## Health statuses

`WORKER_STATUS` defines four values: `HEALTHY`, `DEGRADED`, `STALE`, `OFFLINE`.
Classification is driven by heartbeat freshness in
`reconcileWorkerHealth(now)`, using `WORKER_STALE_MS`:

| Status | Condition | Derived cutoff (defaults) |
|---|---|---|
| `HEALTHY` | Heartbeat within `WORKER_STALE_MS`. | last heartbeat < 30s ago |
| `STALE` | Heartbeat older than `WORKER_STALE_MS` but newer than `3 × WORKER_STALE_MS`. | 30s–90s ago |
| `OFFLINE` | Heartbeat older than `3 × WORKER_STALE_MS`, or set explicitly on graceful stop. | > 90s ago |
| `DEGRADED` | Reserved status value; not currently assigned by `reconcileWorkerHealth`. | — |

```ts
const staleCut   = new Date(now() - env.sync.workerStaleMs);        // 30s
const offlineCut = new Date(now() - env.sync.workerStaleMs * 3);    // 90s
// HEALTHY older than offlineCut         → OFFLINE
// HEALTHY between offlineCut & staleCut → STALE
```

`reconcileWorkerHealth` runs on the scheduler tick (see orchestrator loop). A
worker whose heartbeat lapses is flagged even though its process may be gone —
which is what triggers stalled-job recovery and the `STALE_WORKER` alert.

`activeWorkerCount()` counts only `HEALTHY` workers with a heartbeat inside
`WORKER_STALE_MS` — this is the number exported as the `active_workers` metric.

---

## Worker Health page (`/admin/workers`)

Guarded by the `worker:view` permission. Renders `listWorkers()` (all
`WorkerInstance` rows ordered by most recent heartbeat). Fields available per
worker:

| Field | Source column | Notes |
|---|---|---|
| Worker id | `id` | `worker-<host>-<pid>-<rand>` |
| Hostname / PID | `hostname`, `pid` | |
| Version | `version` | e.g. `0.3.0` |
| Status | `status` | HEALTHY / DEGRADED / STALE / OFFLINE |
| Started at | `startedAt` | |
| Last heartbeat | `lastHeartbeatAt` | freshness basis for status |
| Current jobs | `currentJobs` | in-flight on that worker |
| Completed / Failed | `jobsCompleted`, `jobsFailed` | lifetime counters |
| Avg job duration | `avgJobDurationMs` | |
| Memory | `memoryMb` | RSS in MB |
| Stopped at | `stoppedAt` | set on graceful shutdown |

The Queue Monitoring page (`/admin/queue`) also surfaces a healthy-worker count
(`workers.filter(w => w.status === 'HEALTHY')`).

---

## Graceful shutdown

On `SIGTERM`/`SIGINT` the worker sets `running = false`, which:

1. Stops the job-runner pool from **claiming new jobs** (the `while (running)`
   loops exit after their current iteration).
2. Lets **in-flight jobs finish** — the runners `await` the current
   `processOneJob()` before exiting.
3. Clears the heartbeat timer, calls `markStopped(WORKER_ID)` (→ `OFFLINE`),
   disconnects Prisma, and exits cleanly.

In Docker, `stop_grace_period: 60s` (in `docker-compose.yml`) gives the worker
up to 60 seconds to drain before the container is killed. Raise it if your jobs
run longer than the default so deploys/restarts do not interrupt active work.

---

## Stalled-job recovery

If a worker dies mid-job (crash, OOM, network partition), its claimed job would
otherwise stay `RUNNING` forever. Recovery is handled by `recoverStalledJobs`
(called each scheduler tick via `runSchedulerTick`):

- A `RUNNING` job whose `heartbeatAt` is older than `SYNC_STALLED_JOB_MS`
  (default 120s) is considered **stalled** and is reclaimed (requeued) so
  another worker can pick it up.
- While a job runs, the runner heartbeats it every `~jobLockTtlMs / 3`
  (min 2s), so healthy long-running jobs are never reclaimed prematurely.

This makes crash recovery automatic and requires no manual intervention.

---

## Running one vs. multiple workers

- **One worker**: fully functional. It runs the runner pool
  (`SYNC_WORKER_CONCURRENCY` concurrent runners, default 4) plus the
  orchestrator (scheduler tick, stale-flag refresh, snapshots, alert detectors,
  retention). This is the default `docker-compose.yml` setup (`replicas: 1`).
- **Multiple workers**: each is identical. They all register, all run the
  orchestrator, and all claim jobs. There is intentionally **no primary/replica
  distinction**.

---

## Horizontal scaling

```bash
docker compose up --scale worker=3
```

Correctness under N workers relies on two properties:

1. **Atomic claim → no duplicate processing.** `claimNext` selects candidate
   jobs, then claims one with a *guarded* `updateMany`:

   ```ts
   where: { id: cand.id, status: cand.status, lockedBy: null }
   data:  { status: 'RUNNING', lockedBy: workerId, ... }
   // claim.count === 1  → this worker won; otherwise another worker did.
   ```

   Exactly one worker can transition a given job to `RUNNING`, so no job is
   processed twice. (Verified by the queue benchmark: 0 duplicate-success jobs
   at 10 / 100 / 1000 / 10000 registrations.)

2. **Idempotent scheduling → no leader election.** The scheduler enqueues jobs
   with dedup keys, so every worker can run `enqueueDueJobs` safely — duplicate
   enqueues collapse to a single job. Because scheduling is idempotent and
   claiming is atomic, there is **no need for leader election** for correctness.

Additional guards that keep a scaled fleet well-behaved:

- **Global concurrency ceiling** `SYNC_GLOBAL_MAX_CONCURRENT` (default 16) caps
  total `RUNNING` jobs across the whole fleet.
- **Per-workspace fairness/concurrency** in `claimNext` prefers workspaces with
  fewer running jobs and enforces per-workspace/per-endpoint caps, so one busy
  workspace cannot starve others regardless of worker count.
- **Circuit breaker + rate limits** are DB-backed and therefore shared across
  all workers.

---

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `SYNC_ENABLED` | `true` | Master switch for the runner pool. |
| `SYNC_WORKER_CONCURRENCY` | `4` | Concurrent job runners per worker process. |
| `SYNC_GLOBAL_MAX_CONCURRENT` | `16` | Fleet-wide cap on simultaneously `RUNNING` jobs. |
| `WORKER_HEARTBEAT_MS` | `10000` | Worker heartbeat interval. |
| `WORKER_STALE_MS` | `30000` | Heartbeat age at which a worker becomes STALE; `×3` → OFFLINE. |
| `SYNC_JOB_LOCK_TTL_MS` | `60000` | Job lock TTL; per-job heartbeat runs at ~`/3`. |
| `SYNC_STALLED_JOB_MS` | `120000` | `RUNNING` job age (since last job heartbeat) after which it is reclaimed. |
| `SCHEDULER_ENABLED` | `true` | Enables the orchestrator scheduler tick. |
| `SCHEDULER_INTERVAL_MS` | `30000` | Scheduler tick interval (enqueue due, recover stalled, reap locks, reconcile worker health). |
| `SYNC_TICK_INTERVAL_MS` | `15000` | Idle backoff when `SYNC_ENABLED=false`. |

Docker: `stop_grace_period` in `docker-compose.yml` controls the graceful-drain
window (default `60s`).
