# FastTest Dashboard — API Documentation

Complete endpoint reference for the FastTest Exam-Monitoring dashboard (Node / TypeScript / Express).
This document is generated from the actual route, service, filter and middleware source — every endpoint,
permission, query parameter and response field below is present in the code.

---

## Authentication & authorization model

- **Auth mechanism:** session cookie. On login (`POST /login`) a signed session cookie is set and
  `req.session.userId` is stored (`src/routes/auth.routes.ts`). On every request `attachPrincipal`
  (`src/middleware/auth.ts`) loads the full principal (roles, permissions, school scopes) from the DB.
  A stale/disabled user's session is destroyed automatically.
- **`requireAuth`** — rejects unauthenticated requests.
- **`requirePermission(PERMISSION)`** — implies auth *and* checks a specific permission from the principal's
  permission set.

### 401 vs 403 semantics (`src/middleware/auth.ts`)

| Situation | JSON request (`/api…` or `Accept: application/json`) | Page request |
|-----------|------------------------------------------------------|--------------|
| Not authenticated | `401 { "error": "Authentication required" }` | redirect to `/login` |
| Authenticated but missing permission | `403 { "error": "Forbidden", "required": "<permission>" }` | `403` rendered `error` page |

- **401 = "you are not logged in."**
- **403 = "you are logged in but lack the required permission"** (or the requested resource is outside your
  school scope — several endpoints return `403 { "error": "Forbidden" }` when a school-scoped user requests a
  school/registration outside their scope).

### School scoping (server-enforced, non-bypassable)

`SCHOOL_USER` principals are *school-scoped*. `schoolScopeFor(principal)` returns the allowed `schoolId` list
(or `['__none__']` when they have no schools). This list is **ANDed into every query in the database** via
`buildRegistrationWhere(filter, scopeSchoolIds)` — it is never taken from user input and cannot be widened by
query params (`src/services/filters.ts`, `src/middleware/auth.ts`).

### Pagination & sorting (all list endpoints)

All list endpoints are **server-side paginated** (nothing is filtered or sorted in the browser).

| Param | Rules |
|-------|-------|
| `page` | integer, min 1, default 1 |
| `pageSize` | integer, min 1, **max 200**, default 25 |
| `sortBy` | **allow-listed only** — any value outside the allow-list falls back to `updatedAt` |
| `sortDir` | `asc` \| `desc` (default `desc`) |

Registration sort allow-list (`SORTABLE_COLUMNS`, `src/services/filters.ts`):
`updatedAt`, `createdAt`, `lastSyncAt`, `dashboardStatus`, `studentExternalId`, `examSubject`, `grade`,
`syncStatus`, `testCodeNormalized`.

Paginated list responses have the shape:

```json
{ "rows": [ ... ], "page": 1, "pageSize": 25, "total": 1234, "totalPages": 50 }
```

---

## Permission → role matrix

Source of truth: `ROLE_PERMISSIONS` in `src/services/rbac.service.ts`. `ADMINISTRATOR` receives **all**
permissions (`Object.values(PERMISSION)`).

| PERMISSION key | string value | ADMINISTRATOR | OPERATIONS | ASSESSMENT_TEAM | SCHOOL_USER | VIEWER |
|----------------|--------------|:---:|:---:|:---:|:---:|:---:|
| `DASHBOARD_VIEW` | `dashboard:view` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `MONITORING_VIEW` | `monitoring:view` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `STUDENT_VIEW` | `student:view` | ✅ | ✅ | ✅ | ✅ | — |
| `RESULTS_VIEW` | `results:view` | ✅ | ✅ | ✅ | — | — |
| `RAW_RESPONSE_VIEW` | `raw:view` | ✅ | — | — | — | — |
| `IMPORT_RUN` | `import:run` | ✅ | — | — | — | — |
| `EXPORT_RUN` | `export:run` | ✅ | ✅ | ✅ | — | — |
| `MANUAL_SYNC` | `sync:manual` | ✅ | ✅ | — | — | — |
| `INTEGRATION_MANAGE` | `integration:manage` | ✅ | — | — | — | — |
| `API_MONITORING_VIEW` | `apimonitoring:view` | ✅ | ✅ | — | — | — |
| `AUDIT_VIEW` | `audit:view` | ✅ | — | — | — | — |
| `USER_MANAGE` | `user:manage` | ✅ | — | — | — | — |
| `LOADTEST_RUN` | `loadtest:run` | ✅ | — | — | — | — |
| `ATTENTION_VIEW` | `attention:view` | ✅ | ✅ | ✅ | — | — |
| `ATTENTION_MANAGE` | `attention:manage` | ✅ | ✅ | — | — | — |
| `SAVED_VIEW_SHARE` | `savedview:share` | ✅ | — | — | — | — |
| `PII_UNMASK` | `pii:unmask` | ✅ | — | ✅ | — | — |
| `SYNC_VIEW` | `sync:view` | ✅ | ✅ | ✅ | — | — |
| `SYNC_BULK` | `sync:bulk` | ✅ | ✅ | — | — | — |
| `SYNC_CANCEL` | `sync:cancel` | ✅ | ✅ | — | — | — |
| `SYNC_RETRY` | `sync:retry` | ✅ | ✅ | — | — | — |
| `SYNC_ADMIN` | `sync:admin` | ✅ | — | — | — | — |
| `QUEUE_VIEW` | `queue:view` | ✅ | ✅ | ✅ | — | — |
| `QUEUE_MANAGE` | `queue:manage` | ✅ | ✅ | — | — | — |
| `WORKER_VIEW` | `worker:view` | ✅ | ✅ | — | — | — |
| `WORKSPACE_PAUSE` | `workspace:pause` | ✅ | ✅ | — | — | — |
| `ALERT_VIEW` | `alert:view` | ✅ | ✅ | ✅ | — | — |
| `ALERT_MANAGE` | `alert:manage` | ✅ | ✅ | — | — | — |

> `ADMINISTRATOR` gets every permission automatically. Any permission not listed for a role is denied for
> that role.

---

## Auth (`src/routes/auth.routes.ts`, mounted at `/`)

| Method | Path | Permission | Body / notes | Success |
|--------|------|-----------|--------------|---------|
| GET | `/login` | none | Redirects to `/` if already logged in | Renders `login` page |
| POST | `/login` | none | `email` (valid email, ≤255), `password` (1–200). **Rate-limited: 20 attempts / 15 min.** | Sets session cookie, redirects to `/`. Invalid input → `400`; bad credentials → `401` (re-renders login). Failed logins are audited. |
| POST | `/logout` | none | — | Destroys session, audits `LOGOUT`, redirects to `/login` |

---

## Health (`src/routes/health.routes.ts`, mounted at `/`, no auth)

| Method | Path | Description / success shape |
|--------|------|------------------------------|
| GET | `/health` | Liveness. `{ "status": "ok", "service": "fasttest-dashboard", "time": <ISO> }` |
| GET | `/health/database` | Runs `SELECT 1`. `{ "status": "ok", "database": "reachable" }` or `503 { "status": "error", "database": "unreachable", "message": … }` |
| GET | `/health/queue` | Sync-job queue depth. `{ "status": "ok", "queued", "running", "failed", "manualReview", "syncEnabled" }` (counts from `SyncJob` by status). `503` on DB error |
| GET | `/health/fasttest` | Per-workspace connectivity. `{ "status": "ok", "workspaces": [ { workspaceName, subjectCode, isActive, syncEnabled, lastAuthenticationStatus, lastAuthenticationAt, lastSuccessfulSyncAt, stale } ] }`. `stale = true` when `lastSuccessfulSyncAt` is null or older than 15 min. `503` on error |

---

## Executive KPIs (`src/routes/api.routes.ts`, mounted at `/api`)

| Method | Path | Permission | Query params | Success |
|--------|------|-----------|--------------|---------|
| GET | `/api/kpis` | `dashboard:view` | Legacy simple filter (school scope auto-applied): `subjectId`, `schoolId`, `grade`, `status`, `search` | `{ kpis, bySubject, bySchool }` |

`kpis` (from `analytics.service.executiveKpis`): `totalRegistered`, per-status counts
(`NOT_STARTED`, `IN_PROGRESS`, `COMPLETED`, `UNDER_REVIEW`, `REVIEW_FAILED`, `UNKNOWN`), `apiErrors`,
`syncErrors`, `syncSuccessRate`, `avgResponseTimeMs`, `avgTimeUsedSeconds`, `avgRawScore`, `avgScaledScore`,
`avgCompletionPercentage`, `completionRate`.
`bySubject` = subject → status → count map. `bySchool` = array of `{ name, total, completed, completionRate }`.

> Note: `/api/kpis` powers the Phase-1 executive dashboard and uses the *legacy* simple filter, not the full
> advanced-filter schema described below.

---

## Registrations (`src/routes/api.routes.ts`, mounted at `/api`)

### GET `/api/registrations` — advanced server-side filtered listing

- **Permission:** `monitoring:view`
- **Pagination/sort:** standard (`page`, `pageSize` ≤200, `sortBy` allow-listed, `sortDir`).
- **Success:** paginated `{ rows, page, pageSize, total, totalPages }`. Each row includes `student`, `school`,
  `subject` and the latest `results[0]` (via `listRegistrationsWhere`).

**Full advanced-filter query-param list** (`advancedFilterSchema`, `src/services/filters.ts`). All are
optional; blank/`null` values are dropped. Text fields are trimmed and capped at 200 chars.

| Param | Type | Matching behaviour |
|-------|------|--------------------|
| `studentId` | string | `studentExternalId` contains |
| `nameArabic` | string | student `nameArabic` contains |
| `nameEnglish` | string | student `nameEnglish` contains |
| `emiratesId` | string | student `emiratesId` contains |
| `schoolId` | string | exact `schoolId` |
| `schoolName` | string | school `name` contains |
| `grade` | string | exact `grade` |
| `classCode` | string | `classCode` contains |
| `subjectId` | string | exact `subjectId` |
| `examSubject` | string | `examSubject` contains |
| `examName` | string | `examName` contains |
| `testCode` | string | matched against `testCodeNormalized` (dashes/spaces stripped, upper-cased) contains |
| `proctorCode` | string | `proctorCode` contains |
| `academicYear` | string | exact `academicYear` |
| `attendance` | string | `attendanceOriginal` contains |
| `status` | string | `dashboardStatus`; single value **or CSV** (`in`) |
| `fastTestStatus` | string | exact `fastTestStatus` |
| `syncStatus` | string | exact `syncStatus` |
| `registrationDateFrom` / `registrationDateTo` | ISO string | `fastTestRegistrationDate` range (lexical string compare) |
| `actualStartFrom` / `actualStartTo` | ISO string | `actualStartTime` range |
| `examStartFrom` / `examStartTo` | ISO string | `startDate` range |
| `examEndFrom` / `examEndTo` | ISO string | `endDate` range |
| `scoreMin` / `scoreMax` | number (coerced) | denormalized result `rawScore` range (via `results.some`) |
| `durationMin` / `durationMax` | integer seconds (coerced) | denormalized result `secondsUsed` range |
| `apiError` | `1` \| `true` \| `yes` | restricts to `syncStatus ∈ {ERROR, MANUAL_REVIEW}` |
| `search` | string | OR over `studentExternalId`, `testCodeOriginal`, `testCodeNormalized`, `examName` |

> The **same** filter object drives the registrations table, analytics endpoints, exports and saved views —
> so KPIs always match the filtered table. School scope is always ANDed in on top of any of the above.

### POST `/api/registrations/:id/sync` — manual sync

- **Permission:** `sync:manual`
- Triggers `syncRegistration(id)`, audits `MANUAL_SYNC`.
- **Success:** the sync result object, e.g. `{ ok: true, dashboardStatus }` or `{ ok: false, errorType }`.

### GET `/api/registrations/export`

Alias of the export handler — see **Export** section (permission `export:run`).

### GET `/api/workspaces`

- **Permission:** `integration:manage`
- Returns masked workspace list (`listWorkspacesMasked` — secrets never exposed).

---

## Analytics dashboard API (`src/routes/dashboard-api.routes.ts`, mounted at `/api/dashboard`)

Every endpoint here builds a **scoped where-clause** from the full advanced-filter query params
(`parseFilter` + `buildRegistrationWhere` with server school scope), so all analytics honor the same filter as
the table. Field definitions and exact formulas are in `docs/DASHBOARD_METRICS.md`.

Unless noted, permission is **`dashboard:view`**. All accept the advanced-filter query params above.

| Method | Path | Permission | Success shape (from `dashboard.service.ts`) |
|--------|------|-----------|---------------------------------------------|
| GET | `/api/dashboard/overview` | `dashboard:view` | KPI block + API health: `totalRegistered`, status counts, `completionRate`, `syncErrors`, `avgTimeUsedSeconds`, `avgCompletionPercentage`, `avgRawScore`, `avgScaledScore`, `correct`, `incorrect`, `skipped`, `apiErrors`, `apiSuccessRate`, `avgResponseTimeMs`, `lastSuccessfulSyncAt` |
| GET | `/api/dashboard/status-distribution` | `dashboard:view` | `{ counts: {NOT_STARTED,IN_PROGRESS,COMPLETED,UNDER_REVIEW,REVIEW_FAILED,UNKNOWN}, total }` |
| GET | `/api/dashboard/schools` | `dashboard:view` | `{ schools: [ { schoolId, externalId, schoolName, total, <status counts>, apiErrors, avgTimeUsed, avgRawScore, avgScaledScore, completionRate } ] }` (sorted by total desc) |
| GET | `/api/dashboard/schools/:schoolId` | `dashboard:view` | School-scoped users outside scope → `403`. `{ schoolId, kpis, byGrade, bySubject, trends, correctIncorrectSkipped }` |
| GET | `/api/dashboard/subjects` | `dashboard:view` | `{ subjects: [ { examSubject, total, <status counts>, avgTimeUsed, avgRawScore, avgScaledScore, correct, incorrect, skipped, completionRate } ] }` |
| GET | `/api/dashboard/subjects/:subject` | `dashboard:view` | `{ subject, kpis, bySchool, byGrade, scoresBySchool, durations, scoreDistribution, trends, workspace }` (`:subject` is URI-decoded and injected as `examSubject`) |
| GET | `/api/dashboard/completion-trends` | `dashboard:view` | `{ trends: [ { date, total, completed } ] }` grouped by `startDate` (ascending) |
| GET | `/api/dashboard/scores` | `dashboard:view` **and** `results:view` | `{ bySubject, bySchool, distribution, correctIncorrectSkipped }` |
| GET | `/api/dashboard/durations` | `dashboard:view` | `{ bySubject: [ { examSubject, avgSeconds } ] }` (sorted by avgSeconds desc) |
| GET | `/api/dashboard/api-health` | `apimonitoring:view` | `{ workspaces: [ … per-workspace health … ], responseTimeTrend, errorDistribution }` |

Per-workspace health object (`api-health`): `workspaceId`, `workspaceName`, `subjectCode`, `isActive`,
`syncEnabled`, `connectionStatus`, `lastAuthenticationAt`, `lastAuthenticationStatus`,
`lastAuthenticationError`, `lastSuccessfulSyncAt`, `avgResponseTimeMs`, `apiSuccessRate`, `staleDataCount`.
Secrets are never exposed.

---

## Saved Views (`src/routes/saved-views.routes.ts`, mounted at `/api/saved-views`)

`savedViewsRouter.use(requireAuth)` — **all endpoints require an authenticated session**; every user manages
their own views. Sharing a view with all users requires `savedview:share`.

| Method | Path | Notes | Success |
|--------|------|-------|---------|
| GET | `/api/saved-views/columns` | Column catalogue for the column-selector UI | `{ columns: [ { key, label, defaultVisible } ], defaults: [<default column keys>] }` |
| GET | `/api/saved-views` | Query `pageType` (default `registrations`) | `{ views: [ hydrated view ] }` |
| GET | `/api/saved-views/:id` | Owner-scoped | Hydrated view, or `404 { error: "Not found" }` |
| POST | `/api/saved-views` | Body validated by `savedViewSchema`; `isShared` honored only with `savedview:share` | `201` hydrated view; invalid → `400` with `details` |
| PUT | `/api/saved-views/:id` | Partial body; owner-only | Hydrated view, or `404 { error: "Not found or not owner" }`; invalid → `400` |
| POST | `/api/saved-views/:id/duplicate` | Clone a view | `201` hydrated view, or `404` |
| POST | `/api/saved-views/:id/default` | Mark as the user's default view (owner-only) | Hydrated view, or `404 { error: "Not found or not owner" }` |
| DELETE | `/api/saved-views/:id` | Owner-only | `{ ok: true }`, or `404 { error: "Not found or not owner" }` |
| PUT | `/api/saved-views/prefs/table` | Per-user table prefs, independent of saved views. Body: `pageType` (≤40, default `registrations`), `columns` (string[]), `pageSize` (1–200, default 25) | `{ ok: true }`; invalid → `400` |

---

## Attention (`src/routes/attention.routes.ts`, mounted at `/`)

`view = requirePermission(attention:view)`, `manage = requirePermission(attention:manage)`.
Read endpoints require `attention:view`; mutations require `attention:manage`. School scope is applied to all
listings.

| Method | Path | Permission | Query / body | Success |
|--------|------|-----------|--------------|---------|
| GET | `/attention` | `attention:view` | `status`, `severity`, `issueType`, `page` | Renders `attention` page (list page-sized 25 + summary) |
| GET | `/api/attention` | `attention:view` | `status`, `severity`, `issueType`, `schoolId`, `assignedToUserId`, `page`, `pageSize` (≤200, default 25) | Paginated attention items (each includes its `registration`) |
| GET | `/api/attention/summary` | `attention:view` | — | Counts/rollup by status/severity/issue (school-scoped) |
| POST | `/api/attention/refresh` | `attention:manage` | — | Recomputes the queue from DB state; audits `ATTENTION_REFRESH`. `{ detected, autoResolved }` |
| POST | `/api/attention/:id/assign` | `attention:manage` | Body `{ userId: string \| null }` | Updated item; invalid → `400` |
| POST | `/api/attention/:id/status` | `attention:manage` | Body `{ status: OPEN \| ACKNOWLEDGED \| RESOLVED }` | Updated item; audits `ATTENTION_STATUS`; invalid → `400 { error: "Invalid status" }` |
| POST | `/api/attention/:id/notes` | `attention:manage` | Body `{ note: string (1–2000) }` | `201` created note; invalid → `400 { error: "Note required" }` |

**Attention issue taxonomy** (`ATTENTION_ISSUE` / `ATTENTION_META`, `src/lib/enums.ts`), each with a severity
and recommended action shown in the queue:

| Issue | Severity |
|-------|----------|
| `API_NOT_FOUND` | HIGH |
| `INVALID_TESTCODE` | HIGH |
| `WORKSPACE_MAPPING_MISSING` | HIGH |
| `AUTH_FAILED` | HIGH |
| `SYNC_FAILED_MAX_RETRIES` | HIGH |
| `REPEATED_API_ERROR` | MEDIUM |
| `STALE_STATUS` | MEDIUM |
| `NO_RESULTS_AFTER_COMPLETION` | MEDIUM |
| `STATUS_CONFLICT` | MEDIUM |
| `MISSING_STUDENT_MAPPING` | LOW |

Attention statuses: `OPEN`, `ACKNOWLEDGED`, `RESOLVED`. Severities: `HIGH`, `MEDIUM`, `LOW`.

---

## Export (`src/routes/export.routes.ts`, mounted at `/`)

All export endpoints require `export:run`. Exports are always school-scoped, respect the same advanced filter,
mask PII unless the caller has `pii:unmask`, never include secrets, and exclude raw API JSON. Every export
records an `ExportJob` (history) and is capped at **5000 rows**. Cells starting with `= + - @ tab CR` are
neutralized to prevent CSV/Excel formula injection.

| Method | Path | Permission | Query params | Success |
|--------|------|-----------|--------------|---------|
| GET | `/export` | `export:run` | — | Renders `export` page with presets + job history |
| GET | `/export/registrations` | `export:run` | `preset` (default `CURRENT_FILTER`), `format` (`csv`\|`xlsx`, default `csv`), `columns` (CSV of column keys), `sortBy`, `sortDir`, + advanced-filter params | File download (`Content-Disposition: attachment`); audits `EXPORT` |
| GET | `/api/registrations/export` | `export:run` | same as above | Same file-download handler |
| GET | `/api/export-jobs` | `export:run` | — | `{ jobs: [ … ] }`. Non-admins see only their own jobs; `user:manage` holders see all |

**Export presets** (`EXPORT_PRESETS`): `ALL`, `CURRENT_FILTER`, `NOT_STARTED`, `IN_PROGRESS`, `COMPLETED`,
`UNDER_REVIEW`, `REVIEW_FAILED`, `UNKNOWN`, `API_ERRORS`, `SYNC_FAILURES`, `SCHOOL_SUMMARY`, `SUBJECT_SUMMARY`,
`RESULTS_SUMMARY`, `ATTENTION`. Status presets apply the matching `status` filter on top of the current
filter; `API_ERRORS`/`SYNC_FAILURES` apply `apiError=1`; `ALL` clears the filter; `CURRENT_FILTER` keeps it.
`SCHOOL_SUMMARY`/`SUBJECT_SUMMARY`/`ATTENTION` produce their own aggregated sheets; `RESULTS_SUMMARY` uses a
fixed results-focused column set; other presets use the caller's selected/default columns.

---

## Integration admin (`src/routes/admin.routes.ts`, mounted at `/`)

| Method | Path | Permission | Body / notes | Success |
|--------|------|-----------|--------------|---------|
| GET | `/admin/integration` | `integration:manage` | — | Renders integration page (masked workspaces + subject mappings) |
| POST | `/admin/integration/workspaces` | `integration:manage` | `workspaceName`, `subjectCode`, `baseUrl` (URL), `tokenTTL` (60–86400, default 3600), optional `restApiKey`, `username`, `password`, `isActive`, `syncEnabled`. Secrets stored **encrypted**. | Redirect with flash; audits `CONFIG_CHANGE`. Invalid → redirect `?msg=Invalid+input` |
| POST | `/admin/integration/workspaces/:id/test` | `integration:manage` | — | Authenticates the workspace; token never returned. `{ ok: true, workspaceName, ttl }`; not found → `404`; auth failure → `502 { ok: false, error, message }` |
| POST | `/admin/integration/mappings` | `integration:manage` | `workspaceId`, `subjectAlias` (≤120). Upserts subject-alias → workspace mapping | Redirect with flash |
| GET | `/admin/api-monitoring` | `apimonitoring:view` | — | Renders API-monitoring page (last 200 request logs + `{ total, avgMs, failures }`) |
| GET | `/admin/audit` | `audit:view` | — | Renders audit-log page (last 200 audit entries) |

---

## Import (`src/routes/import.routes.ts`, mounted at `/`)

All import endpoints require `import:run`. Uploads are in-memory, **max 10 MB, single file**, CSV/XLSX/XLS only.

| Method | Path | Permission | Body / notes | Success |
|--------|------|-----------|--------------|---------|
| GET | `/import` | `import:run` | — | Renders Import Center (last 20 import jobs) |
| POST | `/import/preview` | `import:run` | multipart `file`. Validate only, **no writes** | Renders import result with `preview: true`; missing file or missing required columns → `400` error page |
| POST | `/import/commit` | `import:run` | multipart `file`. Upserts rows | Renders import result with `preview: false`; audits `IMPORT` (`created`/`updated`/`failed` counts); missing file/columns → `400` |
| GET | `/import/:id/errors.csv` | `import:run` | — | CSV download of that job's row-level errors (`rowNumber,column,value,message`, UTF-8 BOM) |

---

## Server-rendered dashboard pages (`src/routes/dashboard.routes.ts`, mounted at `/`)

These render HTML views; the underlying data comes from the same `dashboard.service.ts` functions as the JSON
API above. Charts on each page are enumerated in `docs/DASHBOARD_METRICS.md`.

| Method | Path | Permission | Renders |
|--------|------|-----------|---------|
| GET | `/` | `dashboard:view` | Executive Dashboard (legacy KPIs) |
| GET | `/monitoring` | `monitoring:view` | Live Monitoring table (advanced filters, column selection, saved views, PII masking) |
| GET | `/schools` | `dashboard:view` | Schools Dashboard |
| GET | `/schools/:id` | `dashboard:view` | School Detail (school-scope-checked → `403`/`404`) |
| GET | `/subjects` | `dashboard:view` | Subject Dashboard |
| GET | `/subjects/:subject` | `dashboard:view` | Subject Detail |
| GET | `/registrations/:id` | `student:view` | Student / registration detail (raw API JSON only with `raw:view`; PII unmasked only with `pii:unmask`; school-scope-checked) |

**Phase 3 server-rendered pages** (documented in full in the sync-platform sections below):

| Method | Path | Permission | Renders |
|--------|------|-----------|---------|
| GET | `/admin/queue` | `queue:view` | Queue Monitoring page (see **Sync platform — Queue admin**) |
| GET | `/sync` | `sync:view` | Sync Control Center (see **Sync Control Center**) |
| GET | `/admin/workers` | `worker:view` | Worker Health page (see **Sync platform — Queue admin**) |
| GET | `/admin/sync-history` | `sync:view` | Sync History page (see **Sync platform — Queue admin**) |
| GET | `/admin/alerts` | `alert:view` | Alerts & Monitoring page (see **Sync platform — Queue admin**) |

---

## Sync platform — Queue admin (`src/routes/sync-admin.routes.ts`, mounted at `/`)

| Method | Path | Permission | Params/Body | Success |
|--------|------|-----------|-------------|---------|
| GET | `/admin/queue` | `queue:view` | — | Renders Queue Monitoring page (KPIs, workers, snapshots, dead-letter + failed tables, workspaces w/ circuit breakers, job types) |
| GET | `/api/queue/stats` | `queue:view` | — | Returns `queueStats()` JSON |
| POST | `/api/queue/jobs/:id/retry` | `sync:retry` | — | Retries a job; audits `QUEUE_RETRY`; `{ ok }` |
| POST | `/api/queue/jobs/:id/cancel` | `sync:cancel` | — | Cancels a job; audits `QUEUE_CANCEL`; `{ ok }` |
| POST | `/api/queue/retry-failed` | `sync:retry` | Body optional `{ workspaceId?, jobType? }` | Requeues failed jobs; audits `QUEUE_RETRY_FAILED`; `{ ok: true, requeued: <n> }` |
| POST | `/api/queue/jobs/:id/requeue` | `sync:admin` | — | Requeues a `DEAD_LETTER` job; audits `QUEUE_DEADLETTER_REQUEUE`; `{ ok }` |
| POST | `/api/queue/workspaces/:id/pause` | `workspace:pause` | Body `{ paused: boolean }` (Zod-validated; invalid → `400`) | Pauses/resumes a workspace, invalidates rate config; audits `WORKSPACE_PAUSE`/`WORKSPACE_RESUME`; `{ ok: true }` |
| POST | `/api/queue/job-types/:jobType/pause` | `queue:manage` | Body `{ paused: boolean }` | Pauses/resumes a job type; audits `JOBTYPE_PAUSE`/`JOBTYPE_RESUME`; `{ ok: true }` |
| GET | `/admin/workers` | `worker:view` | — | Renders Worker Health page (`listWorkers()`) |
| GET | `/admin/sync-history` | `sync:view` | Query `page`, optional `status` | Renders Sync History page; paginated `SyncJobAttempt` rows (50/page) + recent `SyncStateTransition` rows |
| GET | `/admin/alerts` | `alert:view` | Query `status` | Renders Alerts & Monitoring page; alerts list + summary |
| GET | `/api/alerts` | `alert:view` | Query `status` | `{ alerts, summary }` JSON |
| POST | `/api/alerts/:id/ack` | `alert:manage` | — | Acknowledges alert; audits `ALERT_ACK`; `{ ok: true }` |
| POST | `/api/alerts/:id/resolve` | `alert:manage` | — | Resolves alert; audits `ALERT_RESOLVE`; `{ ok: true }` |
| POST | `/api/alerts/:id/notes` | `alert:manage` | Body `{ note: string 1–2000 }` (invalid → `400 { error: "Note required" }`) | `201` created alert note |

---

## Sync Control Center (`src/routes/sync-control.routes.ts`, mounted at `/`)

| Method | Path | Permission | Params/Body | Success |
|--------|------|-----------|-------------|---------|
| GET | `/sync` | `sync:view` | — | Renders Sync Control Center: a filtered ops view of registrations (advanced filters, school-scoped) with the latest active queue job per registration (`QUEUED`/`RUNNING`/`RETRY_SCHEDULED`), plus subjects/schools/workspaces for batch actions. Bulk actions are enabled only if the user holds `sync:bulk`. Hard selection cap `MAX_SELECTION = 500` |
| POST | `/api/sync/bulk` | `sync:bulk` | Body `{ action: 'SYNC'\|'CANCEL'\|'MANUAL_REVIEW', registrationIds: string[] (1..500) }` (Zod; exceeding 500 or invalid → `400 { error: 'Invalid input or selection exceeds limit', max: 500 }`) | School scope is enforced: ids are filtered to those the user may act on. `SYNC` enqueues a `MANUAL_SYNC` job (priority 10, dedup-aware) per allowed registration; `CANCEL` cancels active `QUEUED`/`RETRY_SCHEDULED` jobs; `MANUAL_REVIEW` transitions state + sets `syncStatus` `MANUAL_REVIEW` and clears `nextSyncAt`. Audits `SYNC_BULK_<action>`. `{ ok: true, action, requested, affected }` |
| POST | `/api/sync/workspace/:id` | `sync:bulk` | — | Enqueues a `SYNC_WORKSPACE_BATCH` job (priority 70); audits `SYNC_WORKSPACE_BATCH`; `{ ok: true, jobId, deduped }` |
| POST | `/api/sync/school/:id` | `sync:bulk` | School-scope-checked (outside scope → `403`) | Enqueues `SYNC_SCHOOL_BATCH` (priority 70); audits `SYNC_SCHOOL_BATCH`; `{ ok: true, jobId, deduped }` |
| POST | `/api/sync/subject` | `sync:bulk` | Body `{ subject: string }` (required; missing → `400 { error: 'subject required' }`) | Enqueues `SYNC_SUBJECT_BATCH` (priority 70, dedupeKey `SYNC_SUBJECT_BATCH:<subject>`); audits `SYNC_SUBJECT_BATCH`; `{ ok: true, jobId, deduped }` |

---

## Metrics (`src/routes/metrics.routes.ts`, mounted at `/`)

| Method | Path | Permission | Params/Body | Success |
|--------|------|-----------|-------------|---------|
| GET | `/metrics` | Token-gated (NOT session/RBAC) | When `METRICS_TOKEN` env is set, the request must present it as a Bearer token (`Authorization: Bearer <token>`) or `?token=<token>` query param; mismatch → `401 unauthorized` (text/plain). When `METRICS_TOKEN` is blank the endpoint is open | Returns Prometheus text exposition (`text/plain; version=0.0.4`): counters/gauges only — never secrets. On each scrape it refreshes live gauges: queue depth, oldest queued job age (ms), active workers, stale registrations |

---

## Notes on data integrity

- **Averages over zero rows return `null`, rendered as `"N/A"` — never `0`** (see `columns.ts` `display()` and
  the `round2`/null-guard logic in `dashboard.service.ts`). See `docs/DASHBOARD_METRICS.md` for the full
  null-handling contract.
- **Emirates ID is masked** unless the caller holds `pii:unmask` (`maskEmiratesId` in `src/services/columns.ts`).
- **KPIs and the registrations table share one filter** (single source of truth) so numbers always reconcile.
