# Business Requirements Document (BRD)
## FastTest Live Monitoring & Analytics Dashboard

| Field | Value |
|---|---|
| Product | FastTest Live Monitoring & Analytics Dashboard |
| Package | `fasttest-live-dashboard` (v0.1.0) |
| Phase | Phase 1 (MVP) |
| Platform | Node.js ≥ 20, TypeScript, Express, EJS server-rendered views, Prisma ORM |
| Data store | SQLite (dev/test) → PostgreSQL (production); provider-agnostic schema |
| Context | UAE education sector (bilingual Arabic + English student data) |
| Document status | Reflects the implemented codebase as of this version |

---

## 1. Purpose & Background

Student exams are delivered on the external **FastTest** assessment platform (`https://uae.fasttestweb.com/FastTest/api`). Each subject — **Arabic, English, Mathematics, Science** — is delivered from its **own FastTest workspace**, each with its **own REST API key** and base URL. Operational teams need a single place to see, in near-real time:

- **Who is registered** (from internal registration data), combined with
- **Their live FastTest status** (not started / in progress / completed / under review / review failed), and
- **Their FastTest results** (scores, items attempted, time used) once available.

Today this information is fragmented across multiple FastTest workspaces and internal spreadsheets. This product unifies **internal registration data** with **FastTest status and results** into one operational + analytics dashboard.

**Core architectural principle:** all FastTest API calls happen **backend-only**, on a **near-real-time background sync worker**. The dashboard UI reads **only from the internal database** — it never calls FastTest directly. This keeps the UI fast, keeps API keys server-side, and decouples read performance from FastTest availability.

---

## 2. Scope

### 2.1 In Scope (Phase 1)
- Importing internal registration data (CSV / XLSX) with preview, validation, and an error report.
- Configuring multiple FastTest workspaces (one per subject), each with its own encrypted REST API key, base URL, and credentials.
- Mapping free-text source subject aliases (e.g. "Arabic Reading") to a workspace.
- A background sync worker that polls FastTest per-registration on a status-driven cadence and stores status + results in the internal DB.
- Server-rendered dashboard pages that read only from the internal DB: Executive Dashboard, Live Monitoring, Student/Registration Details.
- Operational observability: API Monitoring, health-check endpoints, Audit Log.
- Role-based access control (RBAC) with school-level scoping.
- CSV/XLSX export of the filtered registration view.

### 2.2 Out of Scope (Phase 1)
- Dedicated **Schools Dashboard** and **Subject Dashboard** pages (data is available today only as aggregates on the Executive Dashboard and as filters on Live Monitoring — see §5).
- Saved/named views, scheduled reports, and alerting/notifications.
- Self-service user management UI (users/roles are seeded; the `user:manage` permission exists but there is no CRUD screen).
- Writing back to FastTest (the system is read-only against FastTest).
- Real-time push (WebSockets/SSE); "near-real-time" is achieved by background polling + page refresh.
- The load-testing module is present but **disabled by default** and never enabled in production.

---

## 3. Stakeholders & Roles

Roles are enforced via a permission set attached to each role (see `src/services/rbac.service.ts`, `src/lib/enums.ts`). School-scoped users only see their assigned schools.

| Role (`ROLE`) | Description | Permissions granted |
|---|---|---|
| **ADMINISTRATOR** | Full system owner; manages integration, users, everything | **All** permissions |
| **OPERATIONS** | Day-to-day monitoring & triage | `dashboard:view`, `monitoring:view`, `student:view`, `results:view`, `export:run`, `sync:manual`, `apimonitoring:view` |
| **ASSESSMENT_TEAM** | Views results & analytics | `dashboard:view`, `monitoring:view`, `student:view`, `results:view`, `export:run` |
| **SCHOOL_USER** | School-restricted read access (scoped to assigned schools) | `dashboard:view`, `monitoring:view`, `student:view` |
| **VIEWER** | Read-only executive/monitoring view | `dashboard:view`, `monitoring:view` |

Permission keys in use: `dashboard:view`, `monitoring:view`, `student:view`, `results:view`, `raw:view`, `import:run`, `export:run`, `sync:manual`, `integration:manage`, `apimonitoring:view`, `audit:view`, `user:manage`, `loadtest:run`.

> **School scoping:** a `SCHOOL_USER` is restricted to `UserSchoolScope` school IDs. If a school-scoped user has no scopes assigned, they see nothing (`schoolScopeFor` returns a sentinel that matches no school). Raw FastTest payloads are only visible to holders of `raw:view` (Administrator only by default).

---

## 4. Data Sources

### A. Internal Registration Data (source of truth for "who")
Imported via the Import Center (CSV/XLSX). Recognized columns (`src/services/import/import.service.ts`, `KNOWN_COLUMNS`):

`StudentId`, `NameArabic`, `NameEnglish`, `SchoolId`, `SchoolName`, `Grade`, `EmiratesId`, `ClassCode`, `ExamSubject`, `ExamName`, `StartDate`, `EndDate`, `StartTime`, `EndTime`, `TestCode`, `ProctorCode`, `AccessToken`, `AcademicYear`, `Attendance`.

**Required columns:** `StudentId`, `ExamSubject`, `TestCode`. All others are optional. Header matching is case- and space-insensitive.

The importer upserts into `School`, `Student`, `Subject`, and the core `ExamRegistration` entity. Date fields (`StartDate/EndDate/StartTime/EndTime`) are stored **as source strings — never reformatted or fabricated**.

### B. FastTest Status (per registration)
Fetched by the sync worker from `GET /tests/registration/{code}/status` in the workspace resolved for that registration's subject. Persisted as a `FastTestStatusSnapshot` (full raw payload retained) and denormalized onto the registration (`fastTestStatus`, `dashboardStatus`, `fastTestTestId`, etc.). Raw FastTest statuses (`NEW`, `INPROGRESS`, `COMPLETED`, `INREVIEW`, `FAILEDREVIEW`) are normalized to dashboard statuses.

### C. FastTest Results (per registration)
Fetched from `GET /tests/registration/{code}/results` once a registration reaches a terminal-ish status (`COMPLETED`, `UNDER_REVIEW`, `REVIEW_FAILED`). Parsed into `FastTestResult` + `FastTestScore` rows (full raw payload retained). Calculated fields are derived, **not fabricated** (see §7).

### D. Near-Real-Time Sync
A background worker (`src/workers/sync.worker.ts`) ticks on an interval, selects registrations due for sync, and calls FastTest per-registration under a rate limiter and bounded concurrency. Cadence and retries are policy-driven (`src/services/sync/policy.ts`).

### E. Monitoring & Analytics
KPIs, per-subject and per-school aggregates, and paginated registration lists are computed from the internal DB (`src/services/analytics.service.ts`). API request logs (`ApiRequestLog`) drive the API Monitoring page and health checks.

---

## 5. Functional Requirements (by page)

Legend: **[IMPLEMENTED]** = present in Phase 1 code · **[PLANNED]** = not a dedicated page yet.

### 5.1 Executive Dashboard — **[IMPLEMENTED]** (`GET /`, `dashboard:view`)
- KPIs: total registered; counts by dashboard status (Not Started / In Progress / Completed / Under Review / Review Failed / Unknown); completion rate; API errors; sync errors; sync success rate; average API response time; average time used; average raw & scaled score; average completion %.
- Breakdown of registrations **by subject** and **completion by school** (aggregates).
- Honors all filters and school scoping.

### 5.2 Live Monitoring — **[IMPLEMENTED]** (`GET /monitoring`, `monitoring:view`)
- Paginated, sortable, filterable table of registrations (filters: subject, school, grade, dashboard status, free-text search on StudentId / TestCode / ExamName).
- Pagination: default 25 rows, **max 200** per page. Sort by `updatedAt`, `lastSyncAt`, `dashboardStatus`, `studentExternalId`, `examSubject`, `grade`.
- JSON API equivalents: `GET /api/kpis`, `GET /api/registrations`.

### 5.3 Student / Registration Details — **[IMPLEMENTED]** (`GET /registrations/:id`, `student:view`)
- Full registration detail: student (Arabic + English name), school, subject, workspace, latest status snapshots (last 5), and results with per-score breakdown.
- Raw FastTest JSON shown only to users with `raw:view`.
- School-scoped users are blocked (403) from registrations outside their scope.

### 5.4 Schools Dashboard — **[PLANNED]**
- No dedicated page. Per-school completion aggregates exist today via `completionBySchool` on the Executive Dashboard and via the school filter on Live Monitoring.

### 5.5 Subject Dashboard — **[PLANNED]**
- No dedicated page. Per-subject aggregates exist today via `registrationsBySubject` on the Executive Dashboard and via the subject filter on Live Monitoring.

### 5.6 API Monitoring — **[IMPLEMENTED]** (`GET /admin/api-monitoring`, `apimonitoring:view`)
- Last 200 FastTest API request logs with workspace, endpoint, HTTP status, response time, error code/message, success flag.
- Summary stats: total calls, average response time, failure count.

### 5.7 Integration Settings — **[IMPLEMENTED]** (`GET /admin/integration`, `integration:manage`)
- List workspaces with **masked** secrets, per-subject; create workspaces; **connection test** (authenticates, never returns the token); manage subject-alias → workspace mappings.
- Secrets (`restApiKey`, `username`, `password`) are AES-256-GCM encrypted at rest and never returned raw to the client.

### 5.8 Import Center — **[IMPLEMENTED]** (`GET /import`, `import:run`)
- Upload CSV/XLSX (≤ 10 MB, single file) → **Preview/validate** (no writes) → **Confirm/commit** (upsert).
- Per-row validation, duplicate detection within the file, and a downloadable **error report** CSV (`GET /import/:id/errors.csv`, UTF-8 BOM for Arabic).
- Recent import jobs list with created/updated/skipped/failed counts.

### 5.9 Reports / Export — **[IMPLEMENTED]** (`GET /export/registrations`, `export:run`)
- Export the current filtered registration view as **CSV or XLSX** (`?format=csv|xlsx`), capped at 5,000 rows per export.
- CSV is emitted with a UTF-8 BOM so Excel renders Arabic names correctly.

### 5.10 Audit Log — **[IMPLEMENTED]** (`GET /admin/audit`, `audit:view`)
- Last 200 audit entries (LOGIN, LOGOUT, LOGIN_FAILED, IMPORT, MANUAL_SYNC, EXPORT, CONFIG_CHANGE, …). Details must never contain secrets.

### 5.11 Manual Sync — **[IMPLEMENTED]** (`POST /api/registrations/:id/sync`, `sync:manual`)
- Authorized users can trigger an immediate sync of a single registration; the action is audited.

### Planned (cross-cutting): **[PLANNED]**
- Saved/named views, alerting/notifications, dedicated Schools & Subject pages.

---

## 6. Non-Functional Requirements

| Area | Requirement |
|---|---|
| **Performance** | Filtered dashboard/monitoring views render in **< 3s**. Achieved by reading only from the internal DB (no live FastTest calls on the read path) and by DB indexes on `dashboardStatus`, `schoolId`, `subjectId`, `workspaceId`, `syncStatus`, `nextSyncAt`, `testCodeNormalized`. |
| **Pagination** | All list views paginate (default 25, max 200); exports capped at 5,000 rows. |
| **Near-real-time** | Background sync worker ticks every ~15s (`SYNC_TICK_INTERVAL_MS`) and polls each registration on a status-driven cadence (see §7). |
| **Security** | Session cookies are `httpOnly`, `sameSite=lax`, secure behind HTTPS; Helmet CSP; passwords hashed with bcrypt (12 rounds); FastTest secrets AES-256-GCM encrypted at rest; global per-IP rate limit (300/min) and a stricter login limiter (20 / 15 min). FastTest keys are used **backend-only**. |
| **RBAC** | Permission-gated routes; school-level scoping for `SCHOOL_USER`; raw payloads gated behind `raw:view`. |
| **Auditability** | Sensitive actions (login/logout, import, export, manual sync, config change) are written to `AuditLog`. API calls are logged to `ApiRequestLog`. |
| **Portability** | Provider-agnostic Prisma schema (no native DB enums, raw payloads as TEXT, Float numerics) — only the datasource block changes between SQLite and Postgres. |
| **Observability** | Health endpoints (`/health`, `/health/database`, `/health/queue`, `/health/fasttest`), structured logging (pino) with per-request correlation IDs. |

---

## 7. Key Business Rules

1. **TestCode normalization.** Source TestCodes may contain hyphens/spaces/mixed case (e.g. `FUJ-290-263-565`). They are normalized to the compact upper-cased form (`FUJ290263565`) for FastTest calls and matching, while `testCodeOriginal` is always preserved (`src/lib/testcode.ts`).
2. **Composite uniqueness with workspace.** A registration is unique on **(workspace, normalized TestCode)** — the same TestCode may legitimately exist across subjects/workspaces. Where the workspace is unresolved, uniqueness falls back to **(StudentId, ExamSubject, normalized TestCode)** (`uq_workspace_testcode`, `uq_source_identity`).
3. **Never overwrite original Attendance.** `attendanceOriginal` is set from the source import and, once present, is **never overwritten** on subsequent imports (`commitImport` strips it from the update payload when already set).
4. **Do not fabricate result fields.** `DateCompleted`, `TimeCompleted`, `Attempted`, `TestCode`, and `Status` are never invented from the results endpoint. **`Attempted = correct + incorrect`** (a calculated aggregate); `totalItemsCount = correct + incorrect + skipped`; completion % is derived from those. If item counts are absent, these fields stay null (`src/services/fasttest/results-mapper.ts`).
5. **Backend-only FastTest calls.** All authentication and data fetches happen server-side in the sync worker / connection test. The browser never sees API keys or session tokens; the dashboard reads only the internal DB.
6. **Multiple subject aliases → one workspace.** Several free-text `ExamSubject` values (e.g. "Arabic", "Arabic Reading", "Arabic Writing", "Arabic Language") map to a single workspace via `WorkspaceSubjectMapping` (matched on a normalized, uppercased alias). Resolution order: exact alias mapping → fallback match on workspace `subjectCode`.
7. **Original source strings preserved.** Dates/times from the source are stored as-is (not reformatted), consistent with "do not fabricate."
8. **Full raw payloads retained.** Every status and results payload is stored verbatim (`rawJson`) for diagnostics and forward compatibility; nothing is discarded.

---

## 8. Assumptions
- Each subject maps to exactly one active FastTest workspace, each with a distinct REST API key.
- Source `ExamSubject` values are covered by seeded alias mappings, or an administrator adds the mapping in Integration Settings.
- `StudentId` is a stable external identifier and, with `ExamSubject` + `TestCode`, uniquely identifies a registration in the source feed.
- The FastTest API contract (`/auth/simple`, `/tests/registration/{code}/status`, `/tests/registration/{code}/results`) is stable.
- Production runs on PostgreSQL with a securely generated `ENCRYPTION_KEY` and `SESSION_SECRET`.

## 9. Risks
| Risk | Impact | Mitigation |
|---|---|---|
| Unmapped subject alias on import | Registration cannot resolve a workspace; not synced | Import records `unresolvedSubjects`; admin adds mapping in Integration Settings |
| FastTest outage / rate limiting | Stale data, sync errors | Retry with backoff → `MANUAL_REVIEW`; health check flags stale (>15 min); rate limiter |
| `ENCRYPTION_KEY` rotation without re-entry | Existing encrypted secrets undecryptable | Re-enter API keys in Integration Settings after any key change |
| SQLite in production | Concurrency/scale limits | Switch datasource to PostgreSQL for production |
| Permanent errors (NOT_FOUND / INVALID_TESTCODE / WORKSPACE_MISMATCH) | Registration never syncs | Surfaced as `MANUAL_REVIEW` for operator triage; not retried indefinitely |

---

## 10. Acceptance Criteria
- [ ] An operator can import a CSV/XLSX, preview validation errors, download the error report, and commit valid rows.
- [ ] Committed registrations appear in Live Monitoring and are counted in the Executive Dashboard KPIs.
- [ ] With valid workspace keys, the sync worker populates `dashboardStatus` and, for completed exams, results/scores — visible on Student Details.
- [ ] Filtered monitoring and dashboard views render in **< 3s**.
- [ ] Secrets are stored encrypted and always displayed masked; the connection test authenticates without returning a token.
- [ ] `attendanceOriginal` is never overwritten by re-import.
- [ ] `Attempted` equals `correct + incorrect`; no completion/attempt fields are fabricated.
- [ ] RBAC is enforced: each role sees only its permitted pages; school-scoped users see only their schools; raw payloads require `raw:view`.
- [ ] Login, import, export, manual sync, and config changes are recorded in the Audit Log.
- [ ] All four health endpoints respond and flag stale workspaces (> 15 min since last successful sync).
