# Architecture

FastTest Live Monitoring & Analytics Dashboard is a two-process system:

1. A **web application** (Express + EJS) that authenticates users, renders
   dashboards, and serves a JSON API — reading **only** from the application
   database.
2. A **background sync worker** that is the *sole* caller of the FastTest REST API.
   It polls FastTest, normalizes responses, and persists them to the database.

This separation is the core design invariant: **dashboard users never call FastTest
directly.**

---

## High-level diagram

```
                    ┌──────────────────────────────────────────┐
                    │           FastTest workspaces             │
                    │  (one REST endpoint per subject/subject    │
                    │   group; per-workspace API key + token)    │
                    └──────────────────────────────────────────┘
                                     ▲   │
             POST /auth/simple       │   │  status / results JSON
             GET  /tests/registration/{code}/status
             GET  /tests/registration/{code}/results
                                     │   ▼
        ┌───────────────────────────────────────────────────────────┐
        │              Background Sync Worker (Node)                 │
        │  • tick loop (SYNC_TICK_INTERVAL_MS)                       │
        │  • selects due registrations (nextSyncAt <= now)          │
        │  • bounded concurrency + per-minute rate limiter          │
        │  • FastTestClient: token cache, refresh, 401 retry        │
        │  • status normalization + results mapping                 │
        │  • status-aware next-poll scheduling                      │
        └───────────────────────────────────────────────────────────┘
                                     │  writes
                                     ▼
        ┌───────────────────────────────────────────────────────────┐
        │            Application Database (Prisma ORM)               │
        │   SQLite (dev/test)  ·  PostgreSQL (prod)                  │
        │   registrations · status snapshots · results · scores ·   │
        │   api logs · audit · sync jobs · workspaces · users …     │
        └───────────────────────────────────────────────────────────┘
                                     ▲  reads only
                                     │
        ┌───────────────────────────────────────────────────────────┐
        │            Web Application (Express + EJS)                 │
        │  auth (session + RBAC) · dashboard · monitoring ·         │
        │  import · export · integration admin · API monitoring ·   │
        │  audit · health · JSON API                                │
        └───────────────────────────────────────────────────────────┘
                                     ▲
                                     │ HTTPS (session cookie)
                              ┌─────────────┐
                              │  Browser /  │
                              │  end users  │
                              └─────────────┘
```

The web app and the worker can run as separate processes and even separate
deployments — they communicate only through the shared database.

---

## Component breakdown

### `src/config` — configuration
`env.ts` is a typed, fail-fast environment loader. Required variables throw at
startup if missing; typed helpers (`str`/`int`/`bool`) coerce and validate. It
exposes grouped config for runtime, database, security, bootstrap admin, the
FastTest API (base URL, credentials, token TTL, refresh margin, request timeout,
per-subject keys), and the sync worker.

### `src/lib` — cross-cutting primitives
- **`crypto.ts`** — AES-256-GCM authenticated encryption for workspace secrets at
  rest. Ciphertext format `v1:<iv>:<authTag>:<cipher>` (all base64). The key is
  derived from `ENCRYPTION_KEY` (64-hex, base64-32, or a passphrase hashed to 32
  bytes). Also provides `maskSecret` for safe display.
- **`enums.ts`** — the single source of truth for roles, permissions, FastTest raw
  statuses, normalized dashboard statuses, sync/job statuses, and the **sync error
  taxonomy**. Includes `toDashboardStatus()` which maps raw FastTest statuses to
  normalized ones.
- **`testcode.ts`** — `normalizeTestCode()` / `buildTestCode()`: strip hyphens and
  whitespace, uppercase (`FUJ-290-263-565` → `FUJ290263565`), always keeping the
  original.
- **`logger.ts`** — Pino logger.

### `src/db` — data access
`prisma.ts` exports a single shared `PrismaClient` and a `disconnectPrisma()`
helper. Tests point `DATABASE_URL` at a throwaway SQLite file.

### `src/services` — business logic
- **`auth.service.ts`** — bcrypt hashing (12 rounds) and credential verification.
  Performs a dummy hash on unknown users to blunt timing-based user enumeration.
- **`rbac.service.ts`** — the default role→permission grant map (source of truth for
  the seed and tests), plus `loadPrincipal()` which builds the in-memory
  `AuthPrincipal` (roles, permission set, school scopes).
- **`audit.service.ts`** — writes audit entries; `detail` must never contain
  secrets.
- **`workspace.service.ts`** — resolves the FastTest workspace for a source
  `ExamSubject` (exact alias mapping first, then subject-code fallback), decrypts
  secrets into a `ResolvedWorkspace`, and produces masked DTOs for the admin UI.
- **`fasttest/`** — the FastTest integration:
  - **`client.ts`** (`FastTestClient`) — authenticate (`POST /auth/simple`), fetch
    status and results, classify errors, log every request, and manage tokens.
  - **`token-cache.ts`** — in-memory per-workspace token cache with a refresh
    margin (see below). Tokens live only in the worker process.
  - **`http.ts`** — default transport over Node 20 `fetch` with an `AbortController`
    timeout; surfaces `timedOut` / `networkError` flags. Injectable for tests.
  - **`results-mapper.ts`** — parses a results payload into a normalized result plus
    subscore rows and derives calculated fields (attempted/total items, completion
    %, duration). Never fabricates source fields; keeps the full raw payload.
  - **`types.ts`** — transport and response interfaces.
- **`sync/`**:
  - **`policy.ts`** — polling cadence per status, retry backoff, permanent-error
    classification, and the results-fetch trigger.
  - **`sync.service.ts`** — `syncRegistration()`: the idempotent per-registration
    sync routine.
- **`sync/*` and `observability/*` (Phase 3)** — the durable-sync platform.
  `sync/` holds the durable queue, distributed lock, scheduler, rate limiter,
  adaptive throttler, circuit breaker, error classifier, retry policy, state
  machine, job handlers, and worker registry; `observability/` holds the metrics
  registry, TTL cache, alert engine, snapshot capture, and retention cleanup. Full
  detail is in the Phase 3 section below.
- **`analytics.service.ts`** — KPI computation, subject/school aggregates, and
  paginated/filterable registration reads (with a whitelisted sort column).
- **`import/import.service.ts`** — CSV/XLSX parsing, header canonicalization,
  per-row validation, in-file duplicate detection, and transactional upsert.

### `src/middleware` — request guards
`auth.ts` provides `attachPrincipal` (loads the principal from the session on every
request), `requireAuth`, `requirePermission(permission)`, and `schoolScopeFor()`
for school-level row scoping. JSON vs. HTML responses are chosen automatically.

### `src/routes` — HTTP surface
- `auth.routes.ts` — `/login`, `/logout` (login has a stricter rate limiter).
- `dashboard.routes.ts` — `/`, `/monitoring`, `/registrations/:id`.
- `api.routes.ts` — `/api/kpis`, `/api/registrations`, `/api/registrations/:id/sync`
  (manual sync), `/api/workspaces`.
- `import.routes.ts` — `/import`, preview, commit, error-report CSV.
- `admin.routes.ts` — integration settings, workspace create, connection test,
  subject mappings, API monitoring, audit log.
- `export.routes.ts` — `/export/registrations` (CSV/XLSX).
- `health.routes.ts` — `/health`, `/health/database`, `/health/queue`,
  `/health/fasttest` (no auth).

### `src/workers` — background processing
`sync.worker.ts` is a durable-queue processor (Phase 3). On start it registers a
`WorkerInstance` (unique id `worker-<host>-<pid>-<rand>`) and runs three loops: a
**heartbeat loop** that keeps the instance and its in-flight jobs alive; a **bounded
pool of N job runners**, each performing an atomic claim → run → finalize cycle with
its own per-job heartbeat; and an **orchestrator loop** that ticks the scheduler,
refreshes stale flags, captures metric snapshots, runs the alert detectors, and
applies retention cleanup. Because jobs are claimed atomically, multiple workers
scale horizontally with no duplicate processing, and each worker recovers peers'
stalled jobs. On `SIGTERM`/`SIGINT` it stops claiming and drains in-flight jobs
before exit.

### `src/views` — presentation
EJS templates (`dashboard`, `monitoring`, `student`, `import`, `integration`,
`api-monitoring`, `audit`, `login`, `error`) plus `head`/`nav`/`foot` partials. The
nav renders links conditionally on the viewer's permissions.

---

## Request flow (web app)

```
Browser → Express
  1. correlation-id middleware  (x-correlation-id per request)
  2. pino-http request logging
  3. helmet (CSP) · compression · body parsers · cookie-parser
  4. express-session (signed HTTP-only cookie "ftsid", rolling, sameSite=lax)
  5. global rate limit (300 req/min/IP)
  6. static assets
  7. attachPrincipal  → loads AuthPrincipal from session (stale users are logged out)
  8. route handler
       • requireAuth / requirePermission gate
       • school-scope filter applied to DB queries
       • analytics.service reads from the DB (never FastTest)
       • render EJS or return JSON
  9. 404 / error handler (JSON for /api*, EJS otherwise)
```

The only route that triggers an outbound FastTest call from the web app is the
admin **connection test** (`POST /admin/integration/workspaces/:id/test`), which
authenticates a workspace and returns success/TTL — never the token. Manual sync
(`POST /api/registrations/:id/sync`) reuses the same `syncRegistration()` routine
the worker uses.

---

## Sync flow (worker)

For each due registration, `syncRegistration()` performs:

1. **Load** the registration (skips soft-deleted rows).
2. **Resolve workspace** — prefer the bound `workspaceId`, else resolve by
   `examSubject` (alias mapping → subject-code fallback). If none resolves, mark
   `WORKSPACE_MISMATCH` for manual review. When resolved by subject, bind
   `workspaceId` back onto the registration.
3. **Fetch status** via `GET /tests/registration/{normalizedTestCode}/status`.
4. **Persist a status snapshot** with the full raw JSON payload (never discarded).
5. **Normalize** the raw FastTest status to a dashboard status and **denormalize**
   it (plus test id/name/examinee id/registration date) onto the registration for
   fast dashboard reads. `attendanceOriginal` is **never** overwritten.
6. **Schedule the next poll** by writing `nextSyncAt` from the status-aware policy.
7. **Fetch results once** for terminal-ish statuses (COMPLETED / UNDER_REVIEW /
   REVIEW_FAILED), replacing prior result + score rows transactionally for
   idempotency, and denormalizing `secondsUsed` / start time onto the registration.
8. **Stamp** the workspace's `lastSuccessfulSyncAt`.
9. **On error**, classify and either retry (with backoff) or send to manual review.

The worker's `selectDue()` only considers registrations whose workspace has
`syncEnabled` and `isActive` true and whose `nextSyncAt` is null or past due.

### Polling cadence (from `src/services/sync/policy.ts`)

| Dashboard status                       | Interval        |
|----------------------------------------|-----------------|
| NOT_STARTED (before exam window)       | 600 s (10 min)  |
| NOT_STARTED (during active exam window)| 120 s (2 min)   |
| IN_PROGRESS                            | 45 s            |
| COMPLETED                              | 86 400 s (daily)|
| UNDER_REVIEW                           | 300 s (5 min)   |
| REVIEW_FAILED                          | 900 s (15 min)  |
| UNKNOWN                                | 600 s           |

"Active window" is a best-effort check that `now` falls between the registration's
`startDate` and `endDate`. Results are fetched once when a status becomes
COMPLETED, UNDER_REVIEW, or REVIEW_FAILED, then the registration backs off to the
daily cadence.

---

## Token caching & refresh margin

- Tokens are obtained via `POST /auth/simple` (payload: `apiKey`, `username`, `pwd`,
  `timeSent`, `tokenTTL`) and cached **in-memory, per workspace**, only inside the
  worker/app process — never persisted, never returned to clients.
- A cached token is treated as **expired early** by
  `FASTTEST_TOKEN_REFRESH_MARGIN_SECONDS` (default **300 s**). If
  `now >= expiresAt − margin`, the cache returns null and the client re-authenticates
  proactively, avoiding mid-request expiry.
- On a **401** from a status/results call, the client invalidates the cached token,
  re-authenticates once, and retries the call a single time.
- Each authentication updates the workspace's `lastAuthenticationAt` /
  `lastAuthenticationStatus` / `lastAuthenticationError`.

---

## Error taxonomy & retry backoff

Errors are classified into a normalized taxonomy (`src/lib/enums.ts`), driven by the
HTTP response:

| Condition            | Error type            |
|----------------------|-----------------------|
| Request timed out    | `TIMEOUT`             |
| Network failure      | `CONNECTION_FAILURE`  |
| 401 / 403            | `UNAUTHORIZED`        |
| 404                  | `NOT_FOUND`           |
| 429                  | `RATE_LIMITED`        |
| 5xx                  | `SERVER_ERROR`        |
| other non-OK / parse | `INVALID_RESPONSE`    |

Additional taxonomy members: `TOKEN_EXPIRED`, `AUTH_FAILED`, `INVALID_TESTCODE`,
`WORKSPACE_MISMATCH`.

**Permanent errors** (never retried; sent straight to manual review):
`NOT_FOUND`, `INVALID_TESTCODE`, `WORKSPACE_MISMATCH`.

**Retry backoff** (`RETRY_BACKOFF_SECONDS = [0, 30, 120]`): attempt 1 immediate,
then 30 s, then 120 s. After the retry ceiling (`> 3` attempts) or on a permanent
error, the registration's `syncStatus` becomes `MANUAL_REVIEW`, `nextSyncAt` is
cleared, and it is excluded from automatic polling until acted upon.

The worker also enforces a **per-minute rate limit**
(`FASTTEST_RATE_LIMIT_PER_MINUTE`, default 120); requests exceeding the window are
skipped this tick and retried on the next.

---

## Phase 2 — Analytics & Operational Layer

Phase 2 adds an analytics and operational-workflow layer **on top of** the Phase 1
architecture — nothing was replaced. It still holds the core invariant: the
frontend never calls FastTest and never computes aggregations in the browser. All
new pages read exclusively from the application database, and every aggregate is
computed server-side.

### New components

- **Services**
  - `services/filters.ts` — a 25+ field advanced registration filter. Zod-validates
    untrusted query input, then builds a single Prisma `where` clause
    (`buildRegistrationWhere`) with **server-enforced school scoping**, score /
    duration ranges via the results relation, a sort-column allow-list
    (`safeSort`), and URL (de)serialization (`filterToQuery`).
  - `services/dashboard.service.ts` — all backend aggregations: `overview`,
    `kpiBlock`, `statusDistribution`, `schoolsSummary`, `subjectsSummary`,
    `completionByGrade`, `durationsBySubject`, `scoresBySubject` / `scoresBySchool`,
    `scoreDistribution`, `completionTrends`, `correctIncorrectSkipped`, `apiHealth`,
    and `listRegistrationsWhere`. Every function takes a pre-built (already-scoped)
    `where` clause.
  - `services/columns.ts` — the canonical registration column registry (a getter per
    column, shared by the table and exports), Emirates-ID masking (`maskEmiratesId`),
    and null→`N/A` display (never coerced to 0).
  - `services/saved-views.service.ts` — saved-view CRUD, default/shared rules,
    column sanitization (only known keys persist), and per-user table preferences.
  - `services/export.service.ts` — 14 presets, CSV / XLSX, CSV formula-injection
    neutralization, scope / column / sort awareness, and export-job history.
  - `services/attention.service.ts` — the attention detection rules (10 issue
    types), an idempotent `refreshAttention` with SYSTEM auto-resolve, and
    list / assign / status / notes / summary operations.
- **Routes**
  - `dashboard.routes.ts` — new pages `/schools`, `/schools/:id`, `/subjects`,
    `/subjects/:subject`; `/monitoring` upgraded with advanced filters, column
    selection, and saved views.
  - `dashboard-api.routes.ts` — the JSON analytics API under `/api/dashboard/*`.
  - `saved-views.routes.ts` — `/api/saved-views` (+ `/columns`, `/prefs/table`).
  - `attention.routes.ts` — the `/attention` page and `/api/attention*` endpoints.
  - `export.routes.ts` — the `/export` page, `/export/registrations`,
    `/api/registrations/export`, and `/api/export-jobs`.
  - `api.routes.ts` — `/api/registrations` upgraded to the advanced filters.
- **Views** — `schools.ejs`, `school-detail.ejs`, `subjects.ejs`,
  `subject-detail.ejs`, `attention.ejs`, `export.ejs`, and an upgraded
  `monitoring.ejs`, plus reusable partials (`filters.ejs`, `hbars.ejs`,
  `statusbar.ejs`). They reuse the existing design system with RTL-ready styles and
  empty / loading / skeleton states.

### Aggregation approach

- **DB `groupBy`, not in-app loops.** Per-school and per-subject summaries are
  produced with Prisma `groupBy` (by `schoolId`/`examSubject` × `dashboardStatus`)
  and `aggregate` (`_avg` / `_sum`), so counting and averaging happen in the
  database.
- **Denormalized result dimensions to avoid N+1.** `FastTestResult` carries
  denormalized dimensions (`schoolId`, `subjectId`, `grade`, `examSubject`) and a
  denormalized primary-score summary (`rawScore`, `scaledScore`, `sumScore`,
  `cutScore`, `correctCount`, `incorrectCount`, `skippedCount`), with indexes on
  `schoolId` and `subjectId`. This lets per-school / per-subject analytics run as a
  single indexed `groupBy` instead of joining through score rows on every request.
- **Single shared filter / where so KPIs match the table.** The same
  `buildRegistrationWhere(...)` output feeds the KPI block, the charts, and the
  paginated table on every page. Result-based metrics reuse the same clause through
  the registration relation (`{ registration: { is: where } }`), so a filter narrows
  the KPIs and the underlying rows identically — they can never disagree. Averages
  come from matching `FastTestResult` rows only; when none match the value is
  `null` (rendered `N/A`), never `0`.

### Server-side filtering & school-scope enforcement

All filtering happens in the database. `buildRegistrationWhere` accepts a
`scopeSchoolIds` argument that the route supplies from the authenticated principal
(via `schoolScopeFor`) — never from user input — and AND-combines it into every
query. A school-scoped user who passes another `schoolId` (or hits a school-detail
page outside their scope) gets an empty result or a 403, not another school's data.
The same scope guard is applied to the analytics API, the attention queue, and
exports.

### Saved views & column configuration

`SavedView` stores a reusable filter / sort / column / page-size configuration per
page type (`registrations` | `schools` | `subjects` | `attention`). Views are
private to their owner unless marked shared, and sharing requires the
`savedview:share` permission. A user may mark one default per page type.
`UserTablePreference` stores a per-user default column set independently of saved
views. Column keys are sanitized against the canonical registry on write, so only
known columns are ever persisted. Column resolution order on the monitoring page is
query string → saved user preference → registry defaults.

### Export pipeline

An export records an `ExportJob` (history / audit), builds the same scoped `where`
clause, applies the chosen preset, and streams CSV or XLSX. Presets include ALL,
CURRENT_FILTER, the per-status views, API_ERRORS / SYNC_FAILURES, SCHOOL_SUMMARY,
SUBJECT_SUMMARY, RESULTS_SUMMARY, and ATTENTION. Output honours the selected columns
and sort and is capped at a row ceiling. CSV/Excel formula injection is neutralized
by prefixing risky leading characters, CSV is written with a UTF-8 BOM (Arabic
renders in Excel), Emirates ID is masked unless the actor holds `pii:unmask`, and
raw API JSON and secrets are never exported.

### Attention queue — detection & auto-resolve

`refreshAttention` recomputes the queue from current DB state. It classifies each
non-deleted registration into zero or more of 10 issue types (e.g. API not found,
invalid TestCode, workspace mapping missing, auth failed, repeated API error, stale
status, no results after completion, status conflict, missing student mapping, sync
failed after max retries) and **upserts** one `AttentionItem` per
`(registration, issueType)` — the `@@unique([registrationId, issueType])`
constraint makes recomputation idempotent. Open / acknowledged items that are no
longer detected are auto-resolved with `resolvedBy = 'SYSTEM'`, preserving their
history and notes. Operators can assign, acknowledge, resolve, and annotate items;
`attention:view` gates reads and `attention:manage` gates mutations and the
recompute action. The refresh is triggered on demand (`POST /api/attention/refresh`)
and can be run periodically.

---

## Phase 3 — Durable Sync Platform

Phase 3 hardens the sync engine into a durable, observable, horizontally-scalable
platform **on top of** Phases 1 and 2 — nothing was replaced. The core invariant
still holds: **the frontend never calls FastTest.** Every new page reads only from
the application database, and the durable-queue worker remains the *sole* caller of
the FastTest REST API. What changed is how that single caller is orchestrated:
scheduling, rate limiting, throttling, circuit breaking, retries, and recovery are
now first-class, persisted, and coordinated across any number of workers.

### Queue technology & rationale

The queue is a **database-backed durable queue with atomic row-claim locking — no
Redis, no external broker.** This choice satisfies every capability the platform
needs — persistence, priorities, scheduled/delayed execution, retries, dedup,
dead-letter, distributed locking, and stalled-job recovery — while adding **zero new
infrastructure** and running identically on SQLite (dev) and PostgreSQL (prod).

A job is claimed with a guarded `updateMany`
(`WHERE id = ? AND status = ? AND lockedBy IS NULL`); the update either matches one
row or none, so **exactly one worker wins each job**. General distributed locks
(e.g. token refresh) use a separate `DistributedLock` table keyed by owner +
`expiresAt` + `heartbeatAt`, with read-after-write takeover verification to safely
reclaim an expired lock. On Postgres this can be hardened with
`pg_advisory_xact_lock`, but the portable table approach is the default so the same
code runs on both engines. The platform services live under `src/services/sync` and
`src/services/observability`.

```
   scheduler.tick()                                   observability
   (idempotent, dedupeKey)                    metrics · snapshots · alerts · retention
          │                                              ▲
          ▼                                              │
   ┌────────────┐   atomic claim    ┌──────────┐   run   ┌─────────────┐
   │  SyncJob   │──updateMany WHERE─▶│  worker  │────────▶│  handler    │
   │  (queued)  │  id=? status=?     │  runner  │◀────────│ (1 attempt) │
   └────────────┘  lockedBy IS NULL  └──────────┘ result  └─────────────┘
        ▲               (exactly one wins)  │  per-job heartbeat
        │                                   ▼
        │            complete ── retry (backoff) ── dead-letter
        └──────────────────────────┘ (queue owns retries)
```

### Scheduler

`scheduler.service.ts` computes each registration's `nextSyncAt`, priority,
active-window membership, staleness, and fetch needs, enqueues the jobs that are
due, and refreshes stale flags. Scheduling is **idempotent** — the queue dedupes on
a `dedupeKey`, so enqueuing an already-pending job is a no-op. That idempotency is
what lets **every worker run the scheduler safely**: there is no leader election and
no correctness dependency on a single scheduler owner.

### Rate limiting

`rate-limiter.service.ts` enforces a **per-workspace token bucket** (rps / rpm /
minimum inter-request delay / burst) plus **per-endpoint concurrency limits**.
Configuration comes from the DB (`WorkspaceRateLimit`) layered over environment
defaults. The defaults are deliberately conservative because FastTest's real limits
are not assumed: `RATE_MAX_RPS=2`, `RATE_MAX_RPM=60`, `RATE_MAX_CONCURRENT=3`,
`RATE_MIN_DELAY_MS=200`, `RATE_BURST=5`, `RATE_COOLDOWN_MS=30000`.

### Adaptive throttling

`adaptive.service.ts` tracks rolling **p50 / p95 / p99** latency together with error
and timeout rates and derives a **throttle multiplier** that tightens under stress
and recovers gradually. Thresholds are tuned via `ADAPTIVE_*` env: latency degrades
at 4000 ms, error rate at 0.2, recovery begins after 60000 ms, and the multiplier
never drops below a 0.25 floor.

### Circuit breaker

`circuit-breaker.service.ts` runs a **per-workspace CLOSED / OPEN / HALF_OPEN state
machine**, persisted in `WorkspaceCircuitBreaker`, with separate failure, timeout,
and auth thresholds and **probe-based half-open recovery**. Thresholds come from
`CIRCUIT_*` env: failure 5, timeout 3, auth 3, open window 60000 ms, half-open
probes 2. **Job claiming is circuit-aware** — while a workspace's breaker is OPEN,
its jobs are held back until the probe window opens, so a failing workspace cannot
hammer FastTest or starve healthy workspaces of worker capacity.

### Token lifecycle

Tokens remain **in-memory-only per workspace and are never persisted**. Phase 3 adds
**proactive refresh scheduling** (`FastTestWorkspace.nextTokenRefreshAt`) plus
auth-duration and failure tracking (`authenticationDurationMs`,
`authenticationFailureCount`). Refresh is coordinated through a `DistributedLock`
keyed `"token:<workspaceId>"`, so **only one worker refreshes a given workspace's
token at a time** — the rest reuse the freshly cached token.

### Worker fleet

The worker (`src/workers/sync.worker.ts`) is the durable-queue processor described
under Component breakdown: it registers a `WorkerInstance`, runs a heartbeat loop, a
bounded pool of N concurrent job runners (each claim → run → finalize with a per-job
heartbeat), and an orchestrator loop (scheduler tick, stale-flag refresh, snapshot
capture, alert detectors, retention). Graceful shutdown on `SIGTERM`/`SIGINT` stops
claiming and drains in-flight jobs before exit. Multiple workers **scale
horizontally**: each has a unique id (`worker-<host>-<pid>-<rand>`), claims jobs
atomically (no duplicate processing), heartbeats its liveness, and **recovers peers'
stalled jobs** — stalled recovery reclaims any job whose heartbeat has lapsed past
`SYNC_STALLED_JOB_MS`.

### Observability, alerts, metrics & retention

- **`observability/metrics.service.ts`** — a Prometheus registry (counters and
  gauges) exposed at a **token-gated `/metrics`** endpoint (`METRICS_TOKEN`).
- **`observability/snapshots.service.ts`** — periodic `QueueMetricSnapshot` and
  `WorkspaceHealthSnapshot` capture (feeding the queue-depth-over-time and
  per-workspace trend charts) plus gauge updates.
- **`observability/alert.service.ts`** — **10 alert types** (`WORKSPACE_AUTH_FAILURE`,
  `CIRCUIT_OPENED`, `HIGH_API_ERROR_RATE`, `HIGH_LATENCY`, `QUEUE_BACKLOG`,
  `STALE_WORKER`, `DEAD_LETTER_JOBS`, `REPEATED_500`, `HIGH_STALE_COUNT`,
  `SYNC_STOPPED`) with dedupe (`SystemAlert.dedupeKey`), a lifecycle
  (OPEN / ACKNOWLEDGED / RESOLVED), detectors, and extensible hooks.
- **`observability/retention.service.ts`** — configurable cleanup (`RETENTION_*` env)
  that always preserves active jobs and unresolved alerts.
- **`observability/cache.service.ts`** — a TTL cache with freshness tracking for
  analytics and queue KPIs.

### State machine & error classification

Registration sync is governed by a formal **15-state machine** (`src/lib/sync-state.ts`,
states enumerated in `enums.ts` `SYNC_STATE`): `PENDING`, `QUEUED`,
`SYNCING_STATUS`, `STATUS_SYNCED`, `SYNCING_RESULTS`, `RESULTS_SYNCED`, `COMPLETED`,
`NOT_FOUND`, `AUTH_FAILED`, `API_ERROR`, `TIMEOUT`, `RATE_LIMITED`,
`RETRY_SCHEDULED`, `MANUAL_REVIEW`, `STALE`. Transitions are validated and persisted
to `SyncStateTransition` (from / to / reason / correlationId) for a full history.

Errors are classified by `error-classifier.ts` into **13 `ERROR_CATEGORY` values**
(`AUTHENTICATION`, `TOKEN_EXPIRED`, `NOT_FOUND`, `INVALID_TEST_CODE`,
`WORKSPACE_MISMATCH`, `RATE_LIMIT`, `TIMEOUT`, `NETWORK`, `FASTTEST_INTERNAL_ERROR`,
`INVALID_RESPONSE`, `DATABASE`, `QUEUE`, `UNKNOWN`), each carrying retryability,
severity, and a recommended action. `retry.ts` applies a per-category retry policy
with **full-jitter backoff**. The job handlers (`handlers.ts`) are one dispatcher per
job type running **single-attempt** sync primitives — the queue, not the handler,
owns retries.

### New pages & APIs

Phase 3 adds operator-facing pages that read **only** from the DB: Queue Monitoring
(`/admin/queue`), Sync Control Center (`/sync`), Worker Health (`/admin/workers`),
Sync History (`/admin/sync-history`), and Alerts (`/admin/alerts`), plus the
token-gated Prometheus endpoint (`/metrics`). Their JSON APIs live under
`/api/queue`, `/api/sync`, and `/api/alerts`.

### Migration & docs

The migration `20260713080816_phase3_durable_sync` introduces **13 new models**,
expands `SyncJob`, and adds new `ExamRegistration` / `FastTestWorkspace` columns,
taking the model count from **27 → 38**. For the full design and runbooks see
[PHASE_3_IMPLEMENTATION.md](PHASE_3_IMPLEMENTATION.md) and the dedicated Phase 3
docs: `SYNC_ARCHITECTURE`, `QUEUE_OPERATIONS`, `RATE_LIMITING`, `CIRCUIT_BREAKER`,
`WORKER_OPERATIONS`, `ALERTS_AND_MONITORING`, and `DATA_RETENTION`.

---

## Data model overview

Prisma models fall into groups (full detail in
[DATABASE_SCHEMA.md](DATABASE_SCHEMA.md)):

- **Auth/RBAC:** `User`, `Role`, `Permission`, `RolePermission`, `UserRole`,
  `UserSchoolScope`.
- **Reference/source:** `School`, `Subject`, `Student`.
- **Integration config:** `FastTestWorkspace`, `WorkspaceSubjectMapping`.
- **Core entity:** `ExamRegistration`.
- **Status/results:** `FastTestStatusSnapshot`, `FastTestResult`, `FastTestScore`.
- **Sync orchestration:** `SyncJob` (durable DB-backed queue job, atomically
  claimed), `SyncJobAttempt`, `SyncStateTransition`.
- **Observability/settings:** `ApiRequestLog`, `AuditLog`, `SystemSetting`,
  `ImportJob`, `ImportError`.
- **Phase 2 analytics/operational:** `SavedView`, `UserTablePreference`,
  `ExportJob`, `AttentionItem`, `AttentionNote`.
- **Phase 3 durable-sync platform:** `WorkerInstance`, `WorkerHeartbeat`,
  `DistributedLock`, `WorkspaceRateLimit`, `WorkspaceCircuitBreaker`, `SystemAlert`,
  `AlertNote`, `QueueMetricSnapshot`, `WorkspaceHealthSnapshot`, `QueueControl`.

The dashboard's fast path relies on **denormalized latest status** on
`ExamRegistration` plus append-only `FastTestStatusSnapshot` history. Phase 2 adds
**denormalized analytics dimensions and a primary-score summary** on
`FastTestResult` so per-school / per-subject aggregations are single indexed
`groupBy` queries. The Phase 3 durable-sync migration brings the total model count
to **40** (was 27).

---

## Provider portability (SQLite ↔ PostgreSQL)

The schema is deliberately provider-agnostic so the same code and migrations run on
SQLite (dev/test, zero external dependency) and PostgreSQL (prod). Only the
`datasource` block changes. To keep it portable:

- **No native DB enums.** SQLite lacks enum support, so all statuses/roles are
  `String` columns validated at the application layer (`src/lib/enums.ts`). This
  avoids enum-migration divergence between engines.
- **No native JSON type.** Raw API payloads (`rawJson`) and summaries are stored as
  `String` (TEXT/JSONB-compatible) and (de)serialized in code, so there is no
  Json-type behavioral divergence between SQLite and Postgres.
- **All money/score numerics use `Float`.**

Trade-off: validation and JSON handling live in code rather than the database, in
exchange for a single schema that is fully runnable and testable locally without any
external services.

---

## Security architecture

- **Authentication:** email + password, bcrypt (12 rounds), constant-ish path to
  reduce user enumeration. Sessions use a signed, HTTP-only, `sameSite=lax` cookie
  (`ftsid`), rolling expiry, `secure` toggled by `SESSION_SECURE_COOKIE`.
- **Authorization (RBAC):** five roles — `ADMINISTRATOR`, `OPERATIONS`,
  `ASSESSMENT_TEAM`, `SCHOOL_USER`, `VIEWER` — mapped to fine-grained permissions.
  Routes and nav are permission-gated; `SCHOOL_USER` rows are additionally filtered
  to assigned schools.
- **Secrets at rest:** workspace API keys, usernames, and passwords are encrypted
  with **AES-256-GCM** and only ever surfaced masked in the admin UI. Session tokens
  are cached in-memory only and never persisted or returned to clients.
- **Transport/app hardening:** Helmet with a restrictive CSP, global and login-
  specific rate limiting, request-body size caps, and compression.
- **Auditability:** logins, failed logins, imports, manual syncs, exports, and
  config changes are recorded in `AuditLog`; `detail` must not contain secrets.
  Every outbound FastTest call is recorded in `ApiRequestLog`.

---

## Why "dashboard users never call FastTest directly" holds

1. **Only the worker calls FastTest on a schedule.** The `FastTestClient` is invoked
   by the sync worker and, on demand, by the manual-sync endpoint and the admin
   connection test — never by page renders.
2. **Dashboard/monitoring/detail pages read exclusively from the DB.** All reads go
   through `analytics.service.ts` and Prisma; no page handler makes an outbound
   FastTest request.
3. **Latest status is denormalized** onto `ExamRegistration`, and results/snapshots
   are pre-fetched by the worker, so the UI is fast and resilient to FastTest
   latency or downtime.
4. **Credentials and tokens are confined to the backend.** API keys are stored
   encrypted, decrypted only inside the worker/app process, and session tokens live
   only in the in-memory cache — clients never receive them.

The net effect: the FastTest API is polled at a controlled, rate-limited cadence by
a single component, while any number of dashboard users read a consistent, fast,
locally-stored view.
