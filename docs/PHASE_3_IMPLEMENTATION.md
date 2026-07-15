# Phase 3 Implementation — Durable Sync Platform

Promotes Phase 1/2 synchronization into a durable, observable, rate-limited,
horizontally-scalable near-real-time platform. The existing architecture
(Express + Prisma + EJS + JSON API) was **not replaced** — Phase 3 adds a
database-backed queue and control/observability layers on top.

## Queue technology & rationale

**Database-backed durable queue with atomic row-claim locking** (no Redis).
Chosen because it satisfies every required capability — persistence, priorities,
scheduled/delayed execution, retries, dedup, dead-letter, distributed locking,
stalled recovery — while adding **zero new infrastructure** (the spec prefers
this) and working identically on SQLite (dev) and PostgreSQL (prod).

Jobs are claimed with a guarded `updateMany` (`WHERE id=? AND status=? AND
lockedBy IS NULL`) so exactly one worker wins each job. A separate
`DistributedLock` table (owner + expiresAt + heartbeatAt + read-after-write
takeover verification) provides general distributed locks for token refresh.
On Postgres this can be hardened further with `pg_advisory_xact_lock`; the table
approach is the portable default.

## Database changes (migration `20260713080816_phase3_durable_sync`)

New models: `SyncJob` (full field set), `SyncJobAttempt`, `SyncStateTransition`,
`WorkerInstance`, `WorkerHeartbeat`, `DistributedLock`, `WorkspaceRateLimit`,
`WorkspaceCircuitBreaker`, `SystemAlert`, `AlertNote`, `QueueMetricSnapshot`,
`WorkspaceHealthSnapshot`, `QueueControl`. `ExamRegistration` gained
`syncState`, `syncPriority`, `lastSuccessfulSyncAt`, and stale fields
(`isStale`/`staleSince`/`staleReason`/`staleSeverity`). `FastTestWorkspace`
gained token-lifecycle fields (`nextTokenRefreshAt`, `authenticationDurationMs`,
`authenticationFailureCount`) and `syncPaused`. Indexes added on hot paths
(status+priority+scheduledAt, nextRetryAt, dedupeKey, isStale, syncState, etc.).
Model count **27 → 38**. Non-destructive.

## Services (all under `src/services/sync` and `src/services/observability`)

| Service | Responsibility |
|---|---|
| `queue.service.ts` | enqueue (dedup), atomic claim (fair, concurrency- & circuit-aware), complete/fail (retry/dead-letter/manual), cancel, requeue, retry-failed, recover stalled, pause/resume, stats |
| `lock.service.ts` | distributed locks (acquire/renew/release/withLock/reap) |
| `scheduler.service.ts` | compute nextSyncAt/priority/activeWindow/stale/fetch-needs; enqueue due jobs; refresh stale flags |
| `rate-limiter.service.ts` | per-workspace token bucket (rps/rpm/min-delay/burst), per-endpoint concurrency, config from DB + env |
| `adaptive.service.ts` | rolling p50/p95/p99 + error/timeout rate → throttle multiplier with gradual recovery |
| `circuit-breaker.service.ts` | per-workspace CLOSED/OPEN/HALF_OPEN with thresholds + probe recovery |
| `error-classifier.ts` | HTTP/FastTest → 13 categories + retryability + severity + action |
| `retry.ts` | per-category retry policy, backoff with full jitter |
| `state.ts` + `lib/sync-state.ts` | 15-state machine, validated transitions, persisted history |
| `handlers.ts` | one dispatcher per job type (single-attempt sync primitives; queue owns retries) |
| `worker-registry.service.ts` | worker register/heartbeat/health/stalled reconcile |
| `observability/metrics.service.ts` | Prometheus registry (counters/gauges) |
| `observability/cache.service.ts` | TTL cache with freshness for analytics/queue KPIs |
| `observability/alert.service.ts` | 10 alert types, dedupe, lifecycle, detectors, extensible hooks |
| `observability/snapshots.service.ts` | periodic queue + workspace-health snapshots + gauge updates |
| `observability/retention.service.ts` | configurable cleanup preserving active jobs + unresolved alerts |

## Worker

`src/workers/sync.worker.ts` — rewritten as a durable-queue processor:
registers a `WorkerInstance`, runs a heartbeat loop, a bounded pool of job
runners (each claim→run→finalize with per-job heartbeat), and an orchestrator
loop (scheduler tick, stale-flag refresh, snapshot capture, alert detectors,
retention). Graceful shutdown stops claiming and drains in-flight jobs before
exit. Idempotent scheduling (queue dedup) means every worker can schedule
safely — no leader election required for correctness.

## Monitoring pages & APIs

- **Queue Monitoring** (`/admin/queue`): KPIs, queue-depth trend, jobs by
  type/workspace/priority, dead-letter + failed tables, actions (retry, cancel,
  retry-all-failed, requeue dead-letter, pause/resume workspace & job type).
- **Sync Control Center** (`/sync`): filtered ops view (sync state, queue
  status, next/last sync, stale) + bulk actions (sync/cancel/manual-review,
  max 500) + workspace/school/subject batch.
- **Worker Health** (`/admin/workers`), **Sync History** (`/admin/sync-history`),
  **Alerts** (`/admin/alerts`).
- JSON APIs under `/api/queue`, `/api/sync`, `/api/alerts`, plus token-gated
  Prometheus `/metrics`.

## Security

Backend-only FastTest access preserved; no secrets in queue payloads (only ids);
no tokens in logs (Pino redaction + never persisted); every operational action
is permission-gated and audited. 11 new permissions (`sync:view/bulk/cancel/
retry/admin`, `queue:view/manage`, `worker:view`, `workspace:pause`,
`alert:view/manage`) with conservative defaults — operators get operational
control, `sync:admin` is administrator-only, viewers get none.

## Verification

- `npm test` → **190 passing** across 31 files (mock transport only; no live
  FastTest). New suites: lock, queue, circuit-breaker, scheduler, worker-e2e,
  token-refresh, adaptive+retention, phase3-rbac, plus unit tests for retry,
  error-classifier, sync-state, rate-limiter.
- Queue benchmark (`scripts/perf/queue-bench.ts`, mock client): exactly-once
  processing verified at 10/100/1000/10000 registrations (0 duplicate-success
  jobs, all DONE), ~70 jobs/sec on SQLite (DB-write-bound; higher on Postgres),
  stable memory.
- Live: all Phase 3 pages return 200, `/metrics` emits queue gauges, zero server
  errors.
