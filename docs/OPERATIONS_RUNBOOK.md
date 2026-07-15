# Operations Runbook
## FastTest Live Monitoring & Analytics Dashboard

Audience: Operations and Administrator roles. This runbook covers day-to-day operation, imports, workspace/API-key configuration, running the web + worker processes, health monitoring, sync-status interpretation, secret rotation, backups, and incident response.

All file references are relative to the project root. Where exact values matter (poll intervals, retry backoff), they are read directly from the code and cited.

---

## 1. Processes & Commands

The system runs as **two processes** sharing one database:

| Process | Dev command | Prod command | Purpose |
|---|---|---|---|
| Web server | `npm run dev` | `npm run build` then `npm start` | Serves dashboard pages, JSON API, health checks (port `PORT`, default 3000) |
| Sync worker | `npm run worker` | `npm run worker:prod` | Background near-real-time FastTest sync |

Database / setup commands:

```bash
npm run prisma:generate     # generate Prisma client
npm run prisma:migrate      # create+apply a dev migration (prisma migrate dev)
npm run prisma:deploy       # apply migrations in prod (prisma migrate deploy)
npm run db:seed             # seed roles, permissions, admin, subjects, workspaces
npm run db:reset            # DROP + re-migrate + re-seed (DESTRUCTIVE — dev only)
```

First-time / fresh environment bring-up:

```bash
cp .env.example .env        # then fill in real secrets (see §4)
npm ci
npm run prisma:deploy       # or: npm run prisma:migrate  (dev)
npm run db:seed             # creates the bootstrap admin + subject workspaces
npm run build && npm start  # web
npm run worker:prod         # worker (separate process/container)
```

**Bootstrap admin** (from `.env`): `BOOTSTRAP_ADMIN_EMAIL` / `BOOTSTRAP_ADMIN_PASSWORD` (defaults `admin@fasttest.local` / `ChangeMe!Admin123` — change before production). Re-running `db:seed` is idempotent and re-activates the admin.

### Starting / stopping
- **Start:** run the web and worker commands above (typically as separate systemd services or containers — see `docker-compose.yml`).
- **Stop:** send `SIGTERM`/`SIGINT` (Ctrl-C). Both processes shut down gracefully; the web server force-exits after 10s if a graceful close hangs (`src/server.ts`). The worker finishes its current tick, then exits.
- **Restart the worker** after changing sync-related env vars (`SYNC_ENABLED`, `SYNC_TICK_INTERVAL_MS`, `SYNC_WORKER_CONCURRENCY`, `SYNC_MAX_BATCH`, `FASTTEST_RATE_LIMIT_PER_MINUTE`) — env is read at process start.
- **Multiple workers** can now run at once — the worker is a durable-queue processor, so you can scale it horizontally for throughput and HA (jobs are claimed atomically, no leader election, peers recover each other's stalled jobs). See the Phase 3 sections (§19 for running/scaling, §27 for worker health) for full details.

---

## 2. Daily Operations Checklist

1. **Health:** hit the four health endpoints (§5); confirm DB reachable, queue not backed up, no stale workspaces.
2. **Live Monitoring** (`/monitoring`): scan for registrations in `ERROR` or `MANUAL_REVIEW` sync status.
3. **API Monitoring** (`/admin/api-monitoring`): check failure count and average response time.
4. **MANUAL_REVIEW queue:** triage per §8.
5. **Students Requiring Attention** (`/attention`): click **Recompute Queue**, then work HIGH-severity items first (§18).
6. **Audit Log** (`/admin/audit`): review logins, imports, exports, config changes.
7. **Imports:** process any new registration files via the Import Center (§3).
8. **Analytics review** (optional): scan the Schools (`/schools`) and Subject (`/subjects`) dashboards for schools/subjects lagging on completion (§15).

---

## 3. Importing Registrations (Import Center)

Route: `/import` (permission `import:run`). Flow:

1. **Upload** a CSV or XLSX (≤ 10 MB, one file).
2. **Preview / Validate** (`POST /import/preview`) — validates only, **no writes**. Returns row counts, per-row errors, and unresolved subjects.
3. **Confirm / Commit** (`POST /import/commit`) — upserts valid rows and audits the action (`IMPORT`).
4. **Download error report** — `GET /import/:id/errors.csv` (UTF-8 BOM, opens cleanly in Excel with Arabic).

**Required columns:** `StudentId`, `ExamSubject`, `TestCode`. Recognized optional columns: `NameArabic`, `NameEnglish`, `SchoolId`, `SchoolName`, `Grade`, `EmiratesId`, `ClassCode`, `ExamName`, `StartDate`, `EndDate`, `StartTime`, `EndTime`, `ProctorCode`, `AccessToken`, `AcademicYear`, `Attendance`. Header matching is case/space-insensitive. A sample file is at `scripts/sample-registrations.csv`.

**Matching / upsert key:** `StudentId` + `ExamSubject` + normalized `TestCode`. On re-import of an existing registration, fields are updated **except** `attendanceOriginal`, which is never overwritten once set.

**Validation rules:** required-field presence; TestCode must normalize to ≥ 3 chars; `StartDate`/`EndDate` must be parseable dates if present; duplicate rows within the file (same StudentId/ExamSubject/TestCode) are flagged.

**Unresolved subjects:** if an `ExamSubject` has no alias mapping and no matching workspace `subjectCode`, the row still imports but the registration has no workspace and will not sync. The commit summary lists `unresolvedSubjects` — fix by adding a mapping (§4).

---

## 4. Configuring Workspaces, API Keys & Subject Aliases (Integration Settings)

Route: `/admin/integration` (permission `integration:manage`, Administrator).

- **Seeded defaults:** `db:seed` creates one workspace per subject (Arabic / English / Math / Science) with default alias mappings. If an env key is present (`FASTTEST_KEY_ARABIC` etc.), that workspace's `restApiKey` is seeded (encrypted) and `syncEnabled=true`; a keyless workspace is created with `syncEnabled=false`.
- **Create / edit workspace** (`POST /admin/integration/workspaces`): set `workspaceName`, `subjectCode`, `baseUrl`, `tokenTTL` (60–86400s), and optionally `restApiKey`, `username`, `password`, `isActive`, `syncEnabled`.
- **Secrets are masked & encrypted:** stored AES-256-GCM encrypted (`restApiKeyEncrypted` etc.), displayed masked (e.g. `WSzq********NU8w`), never returned raw to the browser.
- **Connection test** (`POST /admin/integration/workspaces/:id/test`): authenticates against FastTest `POST /auth/simple`. Returns `{ ok: true, workspaceName, ttl }` on success; the token is **never** returned. Failure returns the normalized error type (e.g. `UNAUTHORIZED`, `AUTH_FAILED`). Both outcomes are audited (`CONFIG_CHANGE`).
- **Subject alias mapping** (`POST /admin/integration/mappings`): map a free-text `ExamSubject` alias to a workspace. Aliases are normalized (trimmed, whitespace collapsed, uppercased) and unique per normalized alias. This is how multiple aliases point to one workspace.

**Rule of thumb:** a workspace only syncs when `isActive=true` AND `syncEnabled=true` AND it has a REST API key. A keyless workspace stays `syncEnabled=false` by design.

---

## 5. Health Monitoring

All health endpoints are unauthenticated (`src/routes/health.routes.ts`):

| Endpoint | Checks | Healthy response |
|---|---|---|
| `GET /health` | Liveness | `{ status: "ok", ... }` |
| `GET /health/database` | DB reachable (`SELECT 1`) | `{ status: "ok", database: "reachable" }` (503 if down) |
| `GET /health/queue` | Sync job queue depth | `{ queued, running, failed, manualReview, syncEnabled }` |
| `GET /health/fasttest` | Per-workspace auth/sync freshness | `{ workspaces: [{ ..., stale }] }` |

**Stale threshold:** a workspace is flagged `stale: true` when it has **no successful sync in the last 15 minutes** (`lastSuccessfulSyncAt` older than 15 min, or never). A never-synced or keyless workspace reads as stale — expected until it has a key and has run.

**What to watch:**
- `/health/queue` → rising `manualReview` or `failed`: triage (§8).
- `/health/fasttest` → `stale: true` on a keyed, active workspace: check the worker is running, `SYNC_ENABLED`, and the API key (connection test).

---

## 6. Sync Statuses — Interpretation

**Registration sync status** (`ExamRegistration.syncStatus`):

| Status | Meaning | Action |
|---|---|---|
| `PENDING` | Never synced yet (fresh import) | None; worker will pick it up |
| `OK` | Last sync succeeded | None |
| `ERROR` | Transient failure; will retry on backoff | Monitor; auto-retries |
| `MANUAL_REVIEW` | Gave up (permanent error or retries exhausted) | Operator triage (§8) |

**Dashboard status** (`ExamRegistration.dashboardStatus`), normalized from raw FastTest status:

| Raw FastTest | Dashboard status |
|---|---|
| `NEW` | `NOT_STARTED` |
| `INPROGRESS` | `IN_PROGRESS` |
| `COMPLETED` | `COMPLETED` |
| `INREVIEW` | `UNDER_REVIEW` |
| `FAILEDREVIEW` | `REVIEW_FAILED` |
| (missing/unknown) | `UNKNOWN` |

**Sync job status** (`SyncJob.status`): `QUEUED` / `RUNNING` / `DONE` / `FAILED` / `MANUAL_REVIEW`.

Results are fetched **once** when a registration reaches `COMPLETED`, `UNDER_REVIEW`, or `REVIEW_FAILED`, then polling backs off (see §7).

---

## 7. Polling Policy & Retry Backoff

**Poll intervals** (exact seconds, from `src/services/sync/policy.ts` → `POLL_INTERVALS_SECONDS`):

| Condition | Interval |
|---|---|
| Not started, **before** exam window | **600s** (10 min) |
| Not started, **during** active exam window | **120s** (2 min) |
| In progress | **45s** |
| Completed | **86400s** (daily; results fetched once, then back off) |
| Under review | **300s** (5 min) |
| Review failed | **900s** (15 min) |
| Unknown | **600s** (10 min) |

The "active window" is `startDate ≤ now ≤ endDate` on the registration.

**Worker cadence:** the worker ticks every `SYNC_TICK_INTERVAL_MS` (default **15000 ms**), selecting up to `SYNC_MAX_BATCH` (default 50) due registrations, processing them with `SYNC_WORKER_CONCURRENCY` (default 4) and a shared rate limiter of `FASTTEST_RATE_LIMIT_PER_MINUTE` (default 120/min). Rate-limited items are skipped this tick and retried next tick.

**Retry backoff** (`RETRY_BACKOFF_SECONDS = [0, 30, 120]`): on transient error the registration retries after **0s, then 30s, then 120s**. After the retry count exceeds **3** (`SYNC_MAX_RETRIES`), it moves to `MANUAL_REVIEW`.

**Permanent errors are not retried** (`PERMANENT_ERRORS`): `NOT_FOUND`, `INVALID_TESTCODE`, `WORKSPACE_MISMATCH` → straight to `MANUAL_REVIEW` (`nextSyncAt` cleared).

---

## 8. Handling MANUAL_REVIEW Items

Find them via Live Monitoring (filter/sort) or `/health/queue` (`manualReview` count). Each carries a `syncError` string (`ERRORTYPE: message`). Common causes and fixes:

| `syncError` type | Likely cause | Fix |
|---|---|---|
| `WORKSPACE_MISMATCH` | No active workspace resolves the subject | Add/fix subject alias mapping (§4), ensure workspace active |
| `NOT_FOUND` | TestCode not present in that workspace / wrong subject mapping | Verify TestCode + that the alias maps to the correct subject workspace |
| `INVALID_TESTCODE` | Empty/malformed TestCode | Correct the source data and re-import |
| Retries exhausted (`UNAUTHORIZED`, `TIMEOUT`, `SERVER_ERROR`, …) | Persisting transient failure | Fix root cause (key/network), then trigger manual sync |

**Re-drive an item:** trigger a manual sync (§9). A successful sync resets `syncStatus` to `OK` and clears the error.

---

## 9. Manual Sync (authorized users)

`POST /api/registrations/:id/sync` (permission `sync:manual`; Operations & Administrator). Synchronously re-syncs one registration and returns the result; the action is audited (`MANUAL_SYNC`). Use this after fixing a mapping, key, or network issue to clear an item from `ERROR`/`MANUAL_REVIEW`.

---

## 10. Rotating Secrets & Keys

- **FastTest REST API key rotation:** update the key in Integration Settings for the workspace, run the connection test, then confirm the workspace leaves `stale` on `/health/fasttest`. (Env keys `FASTTEST_KEY_*` are only used to seed new workspaces; changing them does not update existing DB rows.)
- **`SESSION_SECRET` rotation:** rotating invalidates existing sessions (users must re-login). Set a strong value in `.env` and restart the web process.
- **`ENCRYPTION_KEY` rotation — CAUTION:** the key encrypts all workspace secrets at rest. **Changing it makes existing ciphertext undecryptable.** After any change you must **re-enter each workspace's API key/username/password** in Integration Settings. Generate a key with:
  ```bash
  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  ```

---

## 11. Backups

- **Database is the source of truth** (registrations, encrypted secrets, audit logs, results). Back it up on a schedule.
  - **PostgreSQL (prod):** `pg_dump` the `DATABASE_URL` database; test restores periodically.
  - **SQLite (dev/test):** back up the `.db` file referenced by `DATABASE_URL` (e.g. `prisma/dev.db`) while the app is quiesced.
- **Back up `.env` / secret material separately and securely** — the DB ciphertext is useless without the matching `ENCRYPTION_KEY`.
- Retain audit logs per your compliance requirement.

---

## 12. Audit Log Review

`/admin/audit` (permission `audit:view`) shows the last 200 entries. Actions include `LOGIN`, `LOGOUT`, `LOGIN_FAILED`, `IMPORT`, `EXPORT`, `MANUAL_SYNC`, `CONFIG_CHANGE`. Details are human-readable and must not contain secrets. Watch for repeated `LOGIN_FAILED` (possible brute force — note the login limiter at §13) and unexpected `CONFIG_CHANGE`.

---

## 13. Security Notes for Operators
- Login is rate-limited to **20 attempts / 15 minutes** per IP; the global limit is 300 requests/min per IP.
- Session cookies are `httpOnly`, `sameSite=lax`; set `SESSION_SECURE_COOKIE=true` behind HTTPS.
- FastTest API keys are used backend-only; the browser never receives keys or tokens.
- The load-testing module is disabled by default (`LOAD_TEST_ENABLED=false`); never enable it in production.

---

## 14. Incident-Response Quick Reference

| Symptom | First checks | Likely fix |
|---|---|---|
| Dashboard down / 500s | `GET /health`, `GET /health/database`; web process logs | Restart web; verify `DATABASE_URL` reachable |
| Data not updating | `GET /health/queue` (`syncEnabled`?), worker process alive? | Start/restart worker; set `SYNC_ENABLED=true`; check workspace keys |
| One/all workspaces `stale` | `GET /health/fasttest`; connection test in Integration Settings | Fix/rotate API key; check `baseUrl`; confirm network |
| Spike in API failures | `/admin/api-monitoring`; `SyncAttempt.errorType` | Address `UNAUTHORIZED`/`RATE_LIMITED`/`TIMEOUT` (see TROUBLESHOOTING.md) |
| Backlog of `MANUAL_REVIEW` | `/health/queue`; per-item `syncError` | Triage per §8, then manual sync |
| Import all failing | Import error report CSV | Fix required columns / dates / TestCode; re-import |
| Cannot decrypt secrets after deploy | Did `ENCRYPTION_KEY` change? | Restore prior key, or re-enter all workspace secrets |
| Migration failure on deploy | `prisma migrate deploy` output; provider match | See TROUBLESHOOTING.md (§migration, §provider mismatch) |

**Escalation order:** confirm which process is affected (web vs worker) → check the relevant health endpoint → check process logs (pino, JSON, correlation-id) → apply the fix above → verify via health endpoint and Live Monitoring.

---

# Phase 2 — Analytics & Operational Features

The following sections cover the Phase 2 analytics and operational-workflow pages. All of them read only from the application database (never FastTest) and enforce school scope server-side: a `SCHOOL_USER` sees only their assigned schools and cannot widen scope by editing filters or URLs.

## 15. Schools & Subject Dashboards

- **Schools Dashboard** (`/schools`, permission `dashboard:view`): per-school totals, status distribution, completion rate, average time-used and raw/scaled score, and API-error counts, alongside per-subject, completion-by-grade, durations, scores, score distribution, and completion-trend charts. **School Details** (`/schools/:id`) drills into one school with its subject breakdown, grade completion, trends, and a scoped registration list. A school user opening a school outside their scope gets a **403**.
- **Subject Dashboard** (`/subjects`): per-subject totals, completion, average duration and scores, item sums (correct/incorrect/skipped), and the serving workspace's health. **Subject Details** (`/subjects/:subject`) drills into one exam subject with per-school and per-grade breakdowns, score distribution, durations, trends, and that subject's workspace health.
- **Data-accuracy note:** every KPI and chart on these pages is computed in the database from the **same filter** as the underlying table, so KPIs and rows always agree. Averages come from result rows only — when none match, the value shows **`N/A`** (never 0). Completion Rate = Completed ÷ total valid registrations × 100.

## 16. Advanced Filters, Saved Views & Column Selection (Live Monitoring)

Live Monitoring (`/monitoring`) is filtered, sorted, and paginated entirely server-side.

- **Advanced filters:** 25+ fields — student/name/Emirates ID, school, grade, class, subject/exam, TestCode, proctor, academic year, attendance, dashboard/FastTest/sync status (status supports multiple via CSV), registration/exam/actual-start date ranges, score range, duration range, an API-error flag, and a free-text search. Filters are reflected in the URL so a filtered view is shareable/bookmarkable (scope is still re-enforced from the session).
- **Column selection:** choose which columns are visible and in what order. Save the choice with **Save as my default** — it is stored per user (and applied on future visits) via `PUT /api/saved-views/prefs/table`. The full column catalogue is available at `GET /api/saved-views/columns`.
- **Saved views:** save the current filter + sort + columns + page size as a named **Saved View** (`POST /api/saved-views`, page type `registrations`). Views are private to their creator unless **shared**; sharing requires the `savedview:share` permission (Administrator). Each user may mark **one default** view per page. Views can be duplicated, set as default, and deleted (soft-deleted). Column resolution order is: explicit query columns → saved user preference → registry defaults.
- **PII:** the Emirates ID column is **masked** for everyone except roles holding `pii:unmask`.

## 17. Reports & Export

Route: **Reports & Export** (`/export`, permission `export:run`). Exports are generated on the server, scope-enforced, and logged as an `ExportJob`.

- **Presets (14):** All Records, Current Filtered View, per-status (Not Started, In Progress, Completed, Under Review, Review Failed, Unknown), API Errors, Sync Failures, School Summary, Subject Summary, Results Summary, and Students Requiring Attention.
- **Formats:** **CSV** (UTF-8 BOM, so Arabic renders correctly in Excel) or **XLSX**.
- **Column/scope/sort aware:** registration exports honour the selected columns and sort; school scope is always applied. Emirates ID is masked unless the actor holds `pii:unmask`. **Raw API JSON and secrets are never exported.**
- **Safety:** cells beginning with formula characters (`= + - @` / tab / CR) are neutralized to prevent CSV/Excel formula injection. Exports are capped at a row ceiling.
- **History:** each export is recorded (`GET /api/export-jobs`) with preset, format, record count, and status. Admins (`user:manage`) see all export jobs; other users see their own. Endpoints: `GET /export/registrations` and `GET /api/registrations/export` (both take `preset`, `format`, `columns`, `sortBy`, `sortDir`, and the standard filter params). Every export is audited (`EXPORT`).

## 18. Students Requiring Attention Queue

Route: **Students Requiring Attention** (`/attention`, permission `attention:view`; mutations require `attention:manage`). The queue turns sync/mapping problems into an actionable, assignable worklist.

- **Recompute Queue** button → `POST /api/attention/refresh` (permission `attention:manage`). This re-scans all non-deleted registrations, **upserts** one item per (registration, issue) so it is idempotent, and **auto-resolves** any previously OPEN/ACKNOWLEDGED item that no longer applies, marking it resolved by **`SYSTEM`** (history and notes are preserved). The action is audited (`ATTENTION_REFRESH`, with detected/auto-resolved counts). This refresh can be run **periodically** (e.g. via a scheduled job hitting the endpoint) as well as on demand.
- **The 10 issue types & recommended actions** (severity in brackets):

  | Issue type | Sev | Recommended action |
  |---|---|---|
  | `API_NOT_FOUND` | HIGH | Verify the TestCode exists in the mapped workspace; confirm subject→workspace mapping. |
  | `INVALID_TESTCODE` | HIGH | Correct the source TestCode and re-import; it fails normalization. |
  | `WORKSPACE_MAPPING_MISSING` | HIGH | Add a subject alias mapping in Integration Settings for this ExamSubject. |
  | `AUTH_FAILED` | HIGH | Check the workspace REST API key/credentials and run a connection test. |
  | `SYNC_FAILED_MAX_RETRIES` | HIGH | Automatic retries exhausted; investigate and resolve, then manual sync. |
  | `REPEATED_API_ERROR` | MEDIUM | Inspect API Monitoring for the workspace; retry after transient errors clear. |
  | `STALE_STATUS` | MEDIUM | Registration hasn't synced recently; trigger a manual sync or check the worker. |
  | `NO_RESULTS_AFTER_COMPLETION` | MEDIUM | Status is COMPLETED but no results returned; re-run results fetch / manual sync. |
  | `STATUS_CONFLICT` | MEDIUM | Source attendance conflicts with FastTest status; verify with the school/proctor. |
  | `MISSING_STUDENT_MAPPING` | LOW | Registration isn't linked to a student record; re-import with a valid StudentId. |

  (Source of truth: `ATTENTION_META` in `src/lib/enums.ts`. "Stale" means no sync in the last 15 minutes while still NOT_STARTED/IN_PROGRESS.)
- **Working an item:** each item can be **assigned** to a user (`POST /api/attention/:id/assign`), moved through **OPEN → ACKNOWLEDGED → RESOLVED** (`POST /api/attention/:id/status`, audited `ATTENTION_STATUS`), and annotated with **notes** (`POST /api/attention/:id/notes`). Filter by status, severity, or issue type; the queue is ordered by severity then most-recently-detected. A severity/issue-type summary is shown at the top (`GET /api/attention/summary`).
- **Relation to §8 (MANUAL_REVIEW):** the attention queue and MANUAL_REVIEW overlap but are complementary — MANUAL_REVIEW is the per-registration sync state, while the attention queue is a de-duplicated, assignable operational view across all issue types. After fixing a root cause (mapping/key/data), run a manual sync (§9) and then **Recompute Queue** so resolved items auto-clear.
- **Scope & permissions:** the queue is school-scoped (school users see only their schools' items); `attention:view` gates reads and `attention:manage` gates refresh, assign, status changes, and notes.

---

# Phase 3 — Durable Sync Platform Operations

The following sections cover the Phase 3 durable-queue sync platform: horizontally scalable workers, the queue monitoring dashboard, bulk sync operations, pausing/resuming, dead-letter handling, circuit-breaker recovery, sync history, alerts, worker health, and metrics. All actions are permission-gated, school-scope-enforced where applicable, and audited.

## 19. Running & Scaling Workers

- **Dev:** `npm run worker`. **Prod:** `npm run worker:prod` (or `node dist/workers/sync.worker.js`).
- The worker is a **durable-queue processor**: it registers a `WorkerInstance` (unique id `worker-<host>-<pid>-<rand>`), runs a heartbeat loop, a bounded pool of `SYNC_WORKER_CONCURRENCY` (default 4) job runners that claim jobs atomically, and an orchestrator loop (scheduler tick, stale refresh, snapshots, alert detectors, retention).
- **Scaling:** run multiple workers for throughput/HA — `docker compose up --scale worker=N` (see `docker-compose.yml` `worker` service). Each worker claims jobs atomically (guarded `updateMany`) so there is **NO duplicate processing**; scheduling is idempotent (queue dedup) so **no leader election** is needed. Peers recover each other's stalled jobs.
- **Graceful shutdown:** `SIGTERM`/`SIGINT` stops claiming and drains in-flight jobs before exit. In Compose, `stop_grace_period` is set (60s) so deploys don't interrupt active work — raise it for long jobs.
- **Global concurrency cap:** `SYNC_GLOBAL_MAX_CONCURRENT` (default 16) bounds total in-flight jobs across the fleet.
- **Restart workers** after changing `SYNC_*` / `RATE_*` / `ADAPTIVE_*` / `CIRCUIT_*` / `RETENTION_*` env — read at process start.

## 20. Queue Monitoring Dashboard (`/admin/queue`)

Permission `queue:view`. Shows queue KPIs (queued / running / retry-scheduled / dead-letter, oldest job age), a queue-depth trend from `QueueMetricSnapshot`, jobs by type/workspace/priority, a worker health summary, and dead-letter + failed tables.

**Actions** (each permission-gated and audited):

| Action | Endpoint | Permission | Audit |
|---|---|---|---|
| Retry a failed job | `POST /api/queue/jobs/:id/retry` | `sync:retry` | `QUEUE_RETRY` |
| Cancel a job | `POST /api/queue/jobs/:id/cancel` | `sync:cancel` | `QUEUE_CANCEL` |
| Retry all failed | `POST /api/queue/retry-failed` (optional `{workspaceId, jobType}`) | `sync:retry` | `QUEUE_RETRY_FAILED` |
| Requeue a dead-letter job | `POST /api/queue/jobs/:id/requeue` | `sync:admin` (administrator only) | `QUEUE_DEADLETTER_REQUEUE` |
| Pause/resume a workspace | `POST /api/queue/workspaces/:id/pause` `{paused}` | `workspace:pause` | `WORKSPACE_PAUSE` / `WORKSPACE_RESUME` |
| Pause/resume a job type | `POST /api/queue/job-types/:jobType/pause` `{paused}` | `queue:manage` | `JOBTYPE_PAUSE` / `JOBTYPE_RESUME` |

## 21. Sync Control Center & Bulk Operations (`/sync`)

Permission `sync:view` to view; `sync:bulk` for actions. A filtered, school-scoped ops view of registrations with sync state, active queue status, next/last sync, and stale flags.

- **Bulk actions** on selected registrations — `POST /api/sync/bulk` `{action, registrationIds}` where `action ∈ SYNC | CANCEL | MANUAL_REVIEW`. Hard cap of **500** selected ids (`MAX_SELECTION`); exceeding it → **400**. School scope is enforced server-side (ids filtered to those the operator may act on). `SYNC` enqueues a high-priority `MANUAL_SYNC` job per registration (dedup-aware); `CANCEL` cancels active queued/retry jobs; `MANUAL_REVIEW` moves them to manual review. Audited `SYNC_BULK_<action>`.
- **Batch by workspace/school/subject** — `POST /api/sync/workspace/:id`, `POST /api/sync/school/:id` (school-scope-checked), `POST /api/sync/subject` `{subject}`. Each enqueues a batch job (priority 70), dedup-aware.

## 22. Pausing & Resuming (workspace / job type)

Pausing is controlled by `QueueControl` rows (scope `WORKSPACE` | `JOB_TYPE`, `scopeKey`, `paused`). Pausing a workspace also sets `FastTestWorkspace.syncPaused=true`. Paused scopes are **skipped by job claiming**; resume clears the pause. Use when a workspace/endpoint is misbehaving or during maintenance. (Endpoints in §20.)

## 23. Dead-Letter Jobs

A job that exhausts `maxAttempts` (default 3) lands in `DEAD_LETTER` (visible on `/admin/queue`). Investigate the `lastErrorCode` / `lastErrorMessage` and the job's `SyncJobAttempt` history (Sync History §25). After fixing the root cause, requeue it (`POST /api/queue/jobs/:id/requeue`, perm `sync:admin`). Dead-letter jobs are retained per `RETENTION_FAILED_JOBS_DAYS` (default 180) — never auto-deleted while unresolved-active.

## 24. Circuit-Breaker Recovery

Each workspace has a `WorkspaceCircuitBreaker` (`CLOSED` / `OPEN` / `HALF_OPEN`). Repeated failures/timeouts/auth failures beyond thresholds (`CIRCUIT_FAILURE_THRESHOLD=5`, `CIRCUIT_TIMEOUT_THRESHOLD=3`, `CIRCUIT_AUTH_THRESHOLD=3`) trip it **OPEN**, halting that workspace's jobs for `CIRCUIT_OPEN_MS` (default 60000ms). It then goes **HALF_OPEN** and sends `CIRCUIT_HALFOPEN_PROBES` (default 2) probe jobs; success **closes** it, failure re-opens. Breaker state shows on `/admin/queue`.

**To recover faster after fixing the cause:** resolve the underlying issue (key/network), optionally resume the workspace; the breaker self-heals via probes.

## 25. Sync History (`/admin/sync-history`)

Permission `sync:view`. Paginated `SyncJobAttempt` records (attempt number, worker, endpoint, status, error category/code, HTTP status, duration, correlation id) plus recent `SyncStateTransition` rows (from→to state, reason). Use to trace why a job failed or a registration entered manual review.

## 26. Alerts Triage (`/admin/alerts`)

Permission `alert:view` to view; `alert:manage` to act. **10 alert types** are detected automatically — `WORKSPACE_AUTH_FAILURE`, `CIRCUIT_OPENED`, `HIGH_API_ERROR_RATE`, `HIGH_LATENCY`, `QUEUE_BACKLOG`, `STALE_WORKER`, `DEAD_LETTER_JOBS`, `REPEATED_500`, `HIGH_STALE_COUNT`, `SYNC_STOPPED` — deduplicated by `dedupeKey` (one open alert per condition, with an occurrence count). Severities: `LOW` / `MEDIUM` / `HIGH` / `CRITICAL`.

- **Acknowledge** — `POST /api/alerts/:id/ack` (audit `ALERT_ACK`).
- **Resolve** — `POST /api/alerts/:id/resolve` (audit `ALERT_RESOLVE`).
- **Add a note** — `POST /api/alerts/:id/notes` `{note}` (`AlertNote`).
- `GET /api/alerts` returns the list + summary as JSON.

## 27. Interpreting Worker Health (`/admin/workers`)

Permission `worker:view`. Lists each `WorkerInstance`: status (`HEALTHY` / `DEGRADED` / `STALE` / `OFFLINE`), last heartbeat, current/completed/failed job counts, avg job duration, memory/CPU. A worker missing heartbeats past `WORKER_STALE_MS` (default 30000ms) is marked **STALE**, and its in-flight jobs become eligible for stalled recovery by peers (after `SYNC_STALLED_JOB_MS`, default 120000ms). Investigate STALE/OFFLINE workers (crashed process, host down).

## 28. Metrics & Snapshots

- **Prometheus metrics:** `GET /metrics` (token-gated by `METRICS_TOKEN` when set — Bearer or `?token=`; blank = open). Emits queue gauges (queue depth, oldest queued job age, active workers, stale registrations) plus counters — **never secrets**. Point your Prometheus scraper here.
- **Snapshots:** the worker periodically writes `QueueMetricSnapshot` (queue KPIs) and `WorkspaceHealthSnapshot` (per-workspace avg/p95 response, error rate, request/stale counts). These back the trend charts on `/admin/queue` and workspace views and are pruned per `RETENTION_METRICS_DAYS` (default 90).

## Dedicated docs

For deeper detail see the dedicated Phase 3 docs: `docs/PHASE_3_IMPLEMENTATION.md`, `docs/SYNC_ARCHITECTURE.md`, `docs/QUEUE_OPERATIONS.md`, `docs/RATE_LIMITING.md`, `docs/CIRCUIT_BREAKER.md`, `docs/WORKER_OPERATIONS.md`, `docs/ALERTS_AND_MONITORING.md`, `docs/DATA_RETENTION.md`.
