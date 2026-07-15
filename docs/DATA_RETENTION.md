# Data Retention

The platform accumulates operational history — API request logs, completed jobs,
worker heartbeats, metric snapshots, audit records. Retention is a **configurable,
age-based cleanup** that prunes this history while **never** touching in-flight
work or unresolved incidents.

- Implementation: `src/services/observability/retention.service.ts`
- Config: `env.retention` in `src/config/env.ts`
- Orchestration: `src/workers/sync.worker.ts` (orchestrator loop)

---

## Retention windows

Each data type has its own window (in days), read from `env.retention` with the
defaults below:

| Data type | Model / table | Deleted when | Retention window | Env var |
|---|---|---|---|---|
| API request logs | `ApiRequestLog` | `requestedAt` older than window | **90 days** | `RETENTION_API_LOGS_DAYS` |
| Completed jobs | `SyncJob` (`DONE`, `CANCELLED`) | `completedAt` older than window | **30 days** | `RETENTION_COMPLETED_JOBS_DAYS` |
| Failed / manual-review jobs | `SyncJob` (`DEAD_LETTER`, `MANUAL_REVIEW`) | `completedAt` older than window | **180 days** | `RETENTION_FAILED_JOBS_DAYS` |
| Worker heartbeats | `WorkerHeartbeat` | `createdAt` older than window | **30 days** | `RETENTION_HEARTBEAT_DAYS` |
| Queue metric snapshots | `QueueMetricSnapshot` | `createdAt` older than window | **90 days** | `RETENTION_METRICS_DAYS` |
| Workspace health snapshots | `WorkspaceHealthSnapshot` | `createdAt` older than window | **90 days** | `RETENTION_METRICS_DAYS` |
| Audit logs | `AuditLog` | `createdAt` older than window | **365 days** | `RETENTION_AUDIT_DAYS` |
| Job attempts (defensive) | `SyncJobAttempt` | `startedAt` older than the failed-jobs window | **180 days** | `RETENTION_FAILED_JOBS_DAYS` |

> Both snapshot tables share `RETENTION_METRICS_DAYS`. Job attempts reuse the
> failed-jobs window; most attempt rows are also removed automatically by FK
> cascade when their parent job is pruned — the age-based delete is a defensive
> backstop for orphans.

---

## What `runRetention` does

`runRetention(now)` runs all deletes in parallel against the configured cutoffs,
then prunes old attempts, logs a summary, and returns per-type counts:

```ts
const [apiLogs, completedJobs, failedJobs, heartbeats,
       queueSnapshots, healthSnapshots, auditLogs] = await Promise.all([
  prisma.apiRequestLog.deleteMany({ where: { requestedAt: { lt: cutoff(r.apiLogsDays, t) } } }),
  prisma.syncJob.deleteMany({ where: { status: { in: ['DONE', 'CANCELLED'] },
                                       completedAt: { lt: cutoff(r.completedJobsDays, t) } } }),
  prisma.syncJob.deleteMany({ where: { status: { in: ['DEAD_LETTER', 'MANUAL_REVIEW'] },
                                       completedAt: { lt: cutoff(r.failedJobsDays, t) } } }),
  prisma.workerHeartbeat.deleteMany({ where: { createdAt: { lt: cutoff(r.heartbeatDays, t) } } }),
  prisma.queueMetricSnapshot.deleteMany({ where: { createdAt: { lt: cutoff(r.metricsDays, t) } } }),
  prisma.workspaceHealthSnapshot.deleteMany({ where: { createdAt: { lt: cutoff(r.metricsDays, t) } } }),
  prisma.auditLog.deleteMany({ where: { createdAt: { lt: cutoff(r.auditDays, t) } } }),
]);
// then: prune old SyncJobAttempt rows defensively
```

It returns a `RetentionResult` with the deleted counts per category, which is
logged as `retention cleanup complete`.

---

## Safety guarantees

Retention is designed to be safe to run on a live system:

- **Never deletes active/queued jobs.** The completed-job delete only matches
  `DONE`/`CANCELLED`; the failed-job delete only matches
  `DEAD_LETTER`/`MANUAL_REVIEW`. Jobs in `QUEUED`, `RUNNING`, `FAILED`, or
  `RETRY_SCHEDULED` are **excluded entirely** — in-flight and retryable work is
  never pruned.
- **Requires a completion timestamp.** Terminal jobs are only eligible once
  `completedAt` is older than the window, so recently-finished jobs are retained.
- **Never deletes unresolved alerts/incidents.** `SystemAlert` and related
  incident records are **not** in the delete set — operational alerts are kept
  regardless of age. (Alerts are cleared through the resolve lifecycle, not by
  retention.)
- **Idempotent.** Deleting by age has no side effects on re-run; running it
  repeatedly is harmless.

```
 delete  ←── ApiRequestLog, WorkerHeartbeat, Queue/Health snapshots, AuditLog
 delete  ←── SyncJob in {DONE, CANCELLED, DEAD_LETTER, MANUAL_REVIEW} (past completedAt)
 keep    ←── SyncJob in {QUEUED, RUNNING, FAILED, RETRY_SCHEDULED}   (active/retryable)
 keep    ←── SystemAlert / unresolved incidents                     (any age)
```

---

## How it runs

- **Automatically** on the worker's orchestrator loop
  (`src/workers/sync.worker.ts`): retention fires roughly **every 6 hours**
  (`now - lastRetention >= 6 * 60 * 60 * 1000`). Failures are caught and logged
  so a retention error never crashes the worker.
- **Manually**: `runRetention()` is a plain exported function and can be invoked
  from a script or one-off task; it takes an optional `now` for testing.

Because deletes are guarded by status and timestamp, running it manually
alongside the scheduled run is safe.

---

## Tuning

Set any `RETENTION_*` env var to change a window. Examples:

```bash
# Keep API logs for 30 days instead of 90
RETENTION_API_LOGS_DAYS=30

# Keep completed jobs longer for reporting
RETENTION_COMPLETED_JOBS_DAYS=60

# Keep dead-letter / manual-review jobs a full year
RETENTION_FAILED_JOBS_DAYS=365

# Compliance: retain audit logs for 7 years
RETENTION_AUDIT_DAYS=2555
```

| Variable | Default (days) | Controls |
|---|---|---|
| `RETENTION_API_LOGS_DAYS` | `90` | `ApiRequestLog` |
| `RETENTION_COMPLETED_JOBS_DAYS` | `30` | `SyncJob` (DONE / CANCELLED) |
| `RETENTION_FAILED_JOBS_DAYS` | `180` | `SyncJob` (DEAD_LETTER / MANUAL_REVIEW) + old `SyncJobAttempt` |
| `RETENTION_HEARTBEAT_DAYS` | `30` | `WorkerHeartbeat` |
| `RETENTION_METRICS_DAYS` | `90` | `QueueMetricSnapshot` + `WorkspaceHealthSnapshot` |
| `RETENTION_AUDIT_DAYS` | `365` | `AuditLog` |

Increasing a window keeps more history (more storage); decreasing it reclaims
space faster. The interval (~6h) is currently fixed in the orchestrator loop.
