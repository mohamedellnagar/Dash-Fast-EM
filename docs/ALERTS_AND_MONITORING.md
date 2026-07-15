# Alerts & Monitoring

The platform ships an internal observability layer: rule-based operational
alerts (with dedupe and a lifecycle), a token-gated Prometheus endpoint,
periodic queue and workspace-health snapshots, a freshness-aware cache, and
correlation IDs that thread a user action through to the resulting DB update.

- Alerts: `src/services/observability/alert.service.ts`
- Metrics: `src/services/observability/metrics.service.ts`
- Snapshots: `src/services/observability/snapshots.service.ts`
- Cache: `src/services/observability/cache.service.ts`
- Routes: `src/routes/sync-admin.routes.ts`, `src/routes/metrics.routes.ts`

---

## Alert types & detector conditions

There are **10 alert types** (`ALERT_TYPE` in `src/lib/enums.ts`). Alerts are
raised by `runAlertDetectors()`, which runs on the worker orchestrator loop
(every ~60s). Each detector evaluates current state and raises (or dedupes) an
alert:

| # | Alert type | Severity | Raised when (detector condition) |
|---|---|---|---|
| 1 | `WORKSPACE_AUTH_FAILURE` | HIGH | Workspace `lastAuthenticationStatus === 'FAILED'` **and** `authenticationFailureCount >= CIRCUIT_AUTH_THRESHOLD` (default 3). |
| 2 | `SYNC_STOPPED` | MEDIUM | Workspace `syncPaused === true`. |
| 3 | `CIRCUIT_OPENED` | HIGH | A `WorkspaceCircuitBreaker` row is in state `OPEN` (detail = `lastTrippedReason`). |
| 4 | `QUEUE_BACKLOG` | MEDIUM | `QUEUED` job count > 1000, **or** the oldest queued job is older than 10 minutes. |
| 5 | `DEAD_LETTER_JOBS` | HIGH | Any job is in `DEAD_LETTER` (count > 0). |
| 6 | `STALE_WORKER` | MEDIUM | Any `WorkerInstance` is `STALE` or `OFFLINE`. |
| 7 | `HIGH_STALE_COUNT` | MEDIUM | More than 100 `ExamRegistration` rows have `isStale = true`. |
| 8 | `HIGH_API_ERROR_RATE` | — | Declared alert type (raised where an elevated API error rate is detected). |
| 9 | `HIGH_LATENCY` | — | Declared alert type for sustained high response latency. |
| 10 | `REPEATED_500` | — | Declared alert type for repeated upstream HTTP 500s. |

> Types 1–7 are raised directly inside `runAlertDetectors`. Types 8–10
> (`HIGH_API_ERROR_RATE`, `HIGH_LATENCY`, `REPEATED_500`) are part of the alert
> taxonomy and share the same dedupe/lifecycle plumbing when raised via
> `raiseAlert`.

---

## Dedupe

Every alert has a `dedupeKey` (defaults to `<alertType>:<workspaceId|global>`).
`raiseAlert` enforces **one non-resolved alert per key**:

```ts
const existing = await prisma.systemAlert.findFirst({
  where: { dedupeKey, status: { not: 'RESOLVED' } },
});
if (existing) {
  // increment occurrences + refresh lastSeenAt + update severity
  return;
}
// else create a new SystemAlert
```

So a recurring condition does **not** create alert spam — it increments
`occurrences` and updates `lastSeenAt` on the single open alert. A new alert is
only created after the previous one is `RESOLVED`. The `dedupeKey` column has a
unique constraint.

---

## Lifecycle

```
   raiseAlert
        │
        ▼
     ┌──────┐   acknowledgeAlert   ┌──────────────┐   resolveAlert   ┌──────────┐
     │ OPEN │ ───────────────────► │ ACKNOWLEDGED │ ───────────────► │ RESOLVED │
     └──────┘                      └──────────────┘                  └──────────┘
        │                                                                 ▲
        └─────────────────────── resolveAlert ────────────────────────────┘
   (occurrences++ on recurrence while not RESOLVED)
```

| Action | Function | Effect |
|---|---|---|
| Acknowledge | `acknowledgeAlert(id)` | `status = ACKNOWLEDGED`, sets `acknowledgedAt`. |
| Resolve | `resolveAlert(id, by)` | `status = RESOLVED`, sets `resolvedAt`, `resolvedBy`. Frees the `dedupeKey` for future occurrences. |
| Assign | `assignAlert(id, userId)` | Sets `assignedToUserId` (nullable). |
| Note | `addAlertNote(id, note, …)` | Appends an `AlertNote` (author user/email, note ≤ 2000 chars). |

`alertSummary()` groups non-resolved alerts by severity for the header badge.

---

## Alerts page, APIs & permissions

**Page:** `/admin/alerts` (`alert:view`) — renders `listAlerts(status)` (ordered
by status, severity, then most recent) plus a severity summary. Supports a
`?status=` filter.

| Endpoint | Method | Permission | Purpose |
|---|---|---|---|
| `/admin/alerts` | GET | `alert:view` | Alerts dashboard (HTML). |
| `/api/alerts` | GET | `alert:view` | JSON list + summary. |
| `/api/alerts/:id/ack` | POST | `alert:manage` | Acknowledge (audited `ALERT_ACK`). |
| `/api/alerts/:id/resolve` | POST | `alert:manage` | Resolve (audited `ALERT_RESOLVE`). |
| `/api/alerts/:id/notes` | POST | `alert:manage` | Add a note (validated, 1–2000 chars). |

Permissions (`PERMISSION` in `src/lib/enums.ts`): `alert:view` (read),
`alert:manage` (act). Manage actions are audited.

---

## Extensible hook mechanism

Alerts do **not** deliver anything externally by default. `registerAlertHook`
lets you attach future email/Teams/PagerDuty delivery without touching the
detectors:

```ts
export type AlertHook = (alert: {
  alertType: string; severity: string; title: string;
  detail?: string | null; workspaceId?: string | null;
}) => Promise<void> | void;

registerAlertHook(async (a) => { /* send email / post to Teams / page */ });
```

Hooks run when a **new** alert is created (not on deduped recurrences), each in a
try/catch so a failing hook cannot break alerting. The **only hook registered by
default is a structured log**:

```ts
// Default hook: structured log (no external delivery).
registerAlertHook((a) => logger.warn({ alert: a.alertType, severity: a.severity,
  workspace: a.workspaceId }, `ALERT: ${a.title}`));
```

There is **no external delivery out of the box** — email/Teams are a documented
extension point, not a shipped feature.

---

## Prometheus `/metrics`

`GET /metrics` exposes an in-process registry in Prometheus text format
(`src/routes/metrics.routes.ts`). It is **token-gated by `METRICS_TOKEN`**:
when the env var is set, the request must present the token as a Bearer header
(`Authorization: Bearer <token>`) or `?token=` query param, else `401`. When
unset, the endpoint is open (dev). It emits **only counters/gauges — never
secrets**. Some gauges are refreshed live from the DB on each scrape
(queue depth, oldest job age, active workers, stale registrations).

### Every metric

| Metric | Type | Meaning |
|---|---|---|
| `fasttest_requests_total` | counter | FastTest API requests. |
| `fasttest_request_duration_ms` | gauge | Last FastTest request duration (ms). |
| `fasttest_errors_total` | counter | FastTest API errors by category. |
| `fasttest_authentication_total` | counter | Workspace authentications. |
| `fasttest_tokens_refreshed_total` | counter | Token refreshes. |
| `sync_jobs_total` | counter | Sync jobs processed, by type/outcome. |
| `sync_jobs_failed_total` | counter | Failed sync jobs. |
| `sync_jobs_retried_total` | counter | Retried sync jobs. |
| `sync_job_duration_ms` | gauge | Last sync job duration (ms). |
| `sync_queue_depth` | gauge | Queued sync jobs (refreshed on scrape). |
| `sync_oldest_job_age_ms` | gauge | Oldest queued job age in ms (refreshed on scrape). |
| `active_workers` | gauge | Healthy worker count (refreshed on scrape). |
| `stale_registrations` | gauge | Stale registration count (refreshed on scrape). |
| `workspace_circuit_state` | gauge | Circuit state per workspace: `0=closed`, `1=half`, `2=open`. |

---

## Periodic snapshots

`captureSnapshots()` runs on the orchestrator loop (~every 60s) and writes two
time-series tables (also used for dashboard trend charts and pruned by
retention):

- **`QueueMetricSnapshot`** — a queue KPI row: `queuedJobs`, `runningJobs`,
  `retryScheduled`, `deadLetterJobs`, `completedLastMin`, `failedLastMin`,
  `oldestJobAgeMs`, `activeWorkers`, `staleRegistrations`. The Queue Monitoring
  page reads the last 60 snapshots for the queue-depth-over-time chart.
- **`WorkspaceHealthSnapshot`** — per workspace: `circuitState`, `avgResponseMs`,
  `p95ResponseMs`, `errorRate`, `requestCount`, `staleCount` (computed from a
  rolling 2-minute window via `rollingStats`).

The same function also updates the live Prometheus gauges
(`queueDepth`, `oldestJobAge`, `activeWorkers`, `staleRegistrations`, and per-
workspace `circuitState`).

---

## Cache freshness

Operational dashboards use a small in-process TTL cache
(`cache.service.ts`) for expensive read-mostly data (analytics, queue KPIs, API
health). The design rule is: **never serve stale operational data silently.**
Every cache entry carries a `computedAt` timestamp, and reads return:

```ts
interface Cached<T> { value: T; computedAt: number; ageMs: number; fromCache: boolean; }
```

So callers can display the data's age and whether it was served from cache,
rather than presenting possibly-stale numbers as if they were live. Secrets are
never cached, and `invalidate(prefix?)` can clear a key, a prefix, or everything.

---

## Correlation IDs

Operational actions are traceable end-to-end:

```
 user action  ──►  queued SyncJob  ──►  FastTest request  ──►  DB update
 (audited)        (job id / attempt)   (ApiRequestLog)        (registration/results)
```

- User-triggered actions (retry, cancel, pause, alert ack/resolve, etc.) are
  written to the **audit log** with actor, action, and entity ids.
- The enqueued **`SyncJob`** carries the ids (registration, workspace,
  normalized test code) — payloads hold ids only, never secrets.
- Each **`SyncJobAttempt`** links back to its job; the Sync History page
  (`/admin/sync-history`) joins attempts + `SyncStateTransition` rows so you can
  follow a registration's sync lifecycle.
- Each outbound **FastTest request** is recorded in `ApiRequestLog`
  (status, latency, error code) — the same data feeds adaptive throttling and
  the health snapshots.

This chain lets an operator start from a user action or an alert and trace it to
the job, the upstream request, and the resulting data change.
