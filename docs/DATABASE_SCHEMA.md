# Database Schema

The data model is defined in [`prisma/schema.prisma`](../prisma/schema.prisma).
It contains **38 `model` blocks** — the 22 Phase 1 models, the five Phase 2
analytics/operational models (`SavedView`, `UserTablePreference`, `ExportJob`,
`AttentionItem`, `AttentionNote`), added by migration
`20260713070938_phase2_analytics`, and 11 net-new Phase 3 durable-sync platform
models (`SyncJobAttempt` — which replaced Phase 1's `SyncAttempt` — plus
`SyncStateTransition`, `WorkerInstance`, `WorkerHeartbeat`, `DistributedLock`,
`WorkspaceRateLimit`, `WorkspaceCircuitBreaker`, `SystemAlert`, `AlertNote`,
`QueueMetricSnapshot`, `WorkspaceHealthSnapshot`, `QueueControl`; the existing
`SyncJob` was expanded in place), added by migration
`20260713080816_phase3_durable_sync`. Every model is documented here. The schema is
provider-agnostic (SQLite for dev/test,
PostgreSQL for prod): statuses are `String` columns validated in code rather than
native DB enums, and raw API payloads are stored as `String` (TEXT/JSONB-compatible)
rather than a native JSON type. See
[ARCHITECTURE.md](ARCHITECTURE.md#provider-portability-sqlite--postgresql) for the
rationale.

## Model index

| # | Model | Group | Purpose |
|---|-------|-------|---------|
| 1 | `User` | Auth/RBAC | Application user accounts |
| 2 | `Role` | Auth/RBAC | Named roles |
| 3 | `Permission` | Auth/RBAC | Fine-grained permissions |
| 4 | `RolePermission` | Auth/RBAC | Role↔Permission join |
| 5 | `UserRole` | Auth/RBAC | User↔Role join |
| 6 | `UserSchoolScope` | Auth/RBAC | School-level row scoping |
| 7 | `School` | Reference | Schools (source `SchoolId`) |
| 8 | `Subject` | Reference | Canonical subjects |
| 9 | `Student` | Reference | Students (source `StudentId`) |
| 10 | `FastTestWorkspace` | Integration | Per-subject FastTest config + encrypted secrets |
| 11 | `WorkspaceSubjectMapping` | Integration | Subject-alias → workspace mapping |
| 12 | `ExamRegistration` | Core | The central operational entity |
| 13 | `FastTestStatusSnapshot` | Status/Results | Append-only status history |
| 14 | `FastTestResult` | Status/Results | Parsed results |
| 15 | `FastTestScore` | Status/Results | Per-subscore breakdown |
| 16 | `SyncJob` | Sync | Sync job orchestration |
| 17 | `SyncAttempt` | Sync | Per-attempt sync record |
| 18 | `ApiRequestLog` | Observability | Outbound FastTest call log |
| 19 | `AuditLog` | Observability | User/action audit trail |
| 20 | `SystemSetting` | Settings | Key/value settings |
| 21 | `ImportJob` | Import | Import job header + counts |
| 22 | `ImportError` | Import | Per-row import errors |
| 23 | `SavedView` | Phase 2 | Reusable filter/sort/column view per page |
| 24 | `UserTablePreference` | Phase 2 | Per-user default columns per page |
| 25 | `ExportJob` | Phase 2 | Export request history / audit |
| 26 | `AttentionItem` | Phase 2 | Attention-queue item per (registration, issue) |
| 27 | `AttentionNote` | Phase 2 | Operator note on an attention item |
| 28 | `SyncJob` (expanded) | Phase 3 | Durable DB-backed queue job (replaces/expands the old §16 `SyncJob`) |
| 29 | `SyncJobAttempt` | Phase 3 | Per-attempt record of a `SyncJob` (replaces the old `SyncAttempt`) |
| 30 | `SyncStateTransition` | Phase 3 | Persisted registration sync-state transition history |
| 31 | `WorkerInstance` | Phase 3 | Registered worker process (health + stalled recovery) |
| 32 | `WorkerHeartbeat` | Phase 3 | Periodic worker heartbeat sample |
| 33 | `DistributedLock` | Phase 3 | General-purpose distributed lock (token refresh etc.) |
| 34 | `WorkspaceRateLimit` | Phase 3 | Per-workspace rate-limit config |
| 35 | `WorkspaceCircuitBreaker` | Phase 3 | Per-workspace circuit-breaker state |
| 36 | `SystemAlert` | Phase 3 | Internal operational alert |
| 37 | `AlertNote` | Phase 3 | Operator note on an alert |
| 38 | `QueueMetricSnapshot` | Phase 3 | Periodic queue KPI snapshot |
| 39 | `WorkspaceHealthSnapshot` | Phase 3 | Periodic per-workspace health snapshot |
| 40 | `QueueControl` | Phase 3 | Pause/resume a workspace or job type |

---

## Conventions

- **IDs:** most models use a `String @id @default(uuid())` primary key. Join tables
  use composite primary keys; `SystemSetting` uses its `key` as the id.
- **Timestamps:** `createdAt @default(now())` and `updatedAt @updatedAt` on most
  entities.
- **Soft delete:** entities that carry `deletedAt DateTime?` are soft-deleted —
  rows are never physically removed by application logic; queries filter
  `deletedAt: null`. Soft delete is used on `User`, `School`, `Student`,
  `FastTestWorkspace`, and `ExamRegistration`.
- **Secrets:** encrypted columns end in `Encrypted` and hold AES-256-GCM ciphertext;
  they are never returned raw to clients (masked in the admin UI).
- **Raw payloads:** `rawJson` columns hold the full FastTest response for
  diagnostics and forward compatibility.

---

## 1. `User`
Application user account.

| Field | Type | Notes |
|-------|------|-------|
| `id` | String (uuid) | PK |
| `email` | String | **unique** |
| `passwordHash` | String | bcrypt hash |
| `fullName` | String | |
| `isActive` | Boolean | default `true` |
| `lastLoginAt` | DateTime? | stamped on login |
| `createdAt` / `updatedAt` | DateTime | |
| `deletedAt` | DateTime? | **soft delete** |

**Relations:** `userRoles` (→ `UserRole`), `schoolScopes` (→ `UserSchoolScope`),
`auditLogs` (→ `AuditLog`), `importJobs` (→ `ImportJob`).
**Indexes:** `@@index([isActive])`.

## 2. `Role`
A named role whose `key` is one of `ADMINISTRATOR`, `OPERATIONS`, `ASSESSMENT_TEAM`,
`SCHOOL_USER`, `VIEWER`.

| Field | Type | Notes |
|-------|------|-------|
| `id` | String (uuid) | PK |
| `key` | String | **unique** (role key) |
| `name` | String | display name |
| `description` | String? | |
| `createdAt` / `updatedAt` | DateTime | |

**Relations:** `userRoles` (→ `UserRole`), `rolePermissions` (→ `RolePermission`).

## 3. `Permission`
A fine-grained permission (e.g. `dashboard:view`, `integration:manage`,
`import:run`).

| Field | Type | Notes |
|-------|------|-------|
| `id` | String (uuid) | PK |
| `key` | String | **unique** (permission key) |
| `description` | String? | |
| `createdAt` | DateTime | |

**Relations:** `rolePermissions` (→ `RolePermission`).

## 4. `RolePermission`
Join table granting a permission to a role.

| Field | Type | Notes |
|-------|------|-------|
| `roleId` | String | FK → `Role` (cascade delete) |
| `permissionId` | String | FK → `Permission` (cascade delete) |

**Primary key:** `@@id([roleId, permissionId])`.

## 5. `UserRole`
Join table assigning a role to a user.

| Field | Type | Notes |
|-------|------|-------|
| `userId` | String | FK → `User` (cascade delete) |
| `roleId` | String | FK → `Role` (cascade delete) |

**Primary key:** `@@id([userId, roleId])`.

## 6. `UserSchoolScope`
Restricts a `SCHOOL_USER` to specific schools (row-level scoping).

| Field | Type | Notes |
|-------|------|-------|
| `userId` | String | FK → `User` (cascade delete) |
| `schoolId` | String | FK → `School` (cascade delete) |

**Primary key:** `@@id([userId, schoolId])`.

---

## 7. `School`
A school; `externalId` maps to the source `SchoolId`.

| Field | Type | Notes |
|-------|------|-------|
| `id` | String (uuid) | PK |
| `externalId` | String | **unique** (source SchoolId) |
| `name` | String | |
| `createdAt` / `updatedAt` | DateTime | |
| `deletedAt` | DateTime? | **soft delete** |

**Relations:** `students` (→ `Student`), `scopes` (→ `UserSchoolScope`),
`registrations` (→ `ExamRegistration`).

## 8. `Subject`
Canonical subject (e.g. `ARABIC`, `ENGLISH`, `MATH`, `SCIENCE`).

| Field | Type | Notes |
|-------|------|-------|
| `id` | String (uuid) | PK |
| `code` | String | **unique** (canonical code) |
| `name` | String | |
| `createdAt` / `updatedAt` | DateTime | |

**Relations:** `registrations` (→ `ExamRegistration`), `mappings`
(→ `WorkspaceSubjectMapping`).

## 9. `Student`
A student; `externalId` maps to the source `StudentId`. Supports Arabic and English
names.

| Field | Type | Notes |
|-------|------|-------|
| `id` | String (uuid) | PK |
| `externalId` | String | **unique** (source StudentId) |
| `nameArabic` | String? | |
| `nameEnglish` | String? | |
| `emiratesId` | String? | |
| `grade` | String? | |
| `classCode` | String? | |
| `schoolId` | String? | FK → `School` |
| `createdAt` / `updatedAt` | DateTime | |
| `deletedAt` | DateTime? | **soft delete** |

**Relations:** `school` (→ `School`), `registrations` (→ `ExamRegistration`).
**Indexes:** `@@index([schoolId])`, `@@index([grade])`.

---

## 10. `FastTestWorkspace`
FastTest integration config for one subject. Holds **encrypted** REST credentials
and tracks authentication/sync health.

| Field | Type | Notes |
|-------|------|-------|
| `id` | String (uuid) | PK |
| `workspaceName` | String | |
| `subjectCode` | String | canonical subject served |
| `baseUrl` | String | FastTest API base URL |
| `restApiKeyEncrypted` | String? | AES-256-GCM ciphertext |
| `usernameEncrypted` | String? | AES-256-GCM ciphertext |
| `passwordEncrypted` | String? | AES-256-GCM ciphertext |
| `isActive` | Boolean | default `true` |
| `syncEnabled` | Boolean | default `true` (worker only polls enabled+active) |
| `tokenTTL` | Int | default `3600` s |
| `lastAuthenticationAt` | DateTime? | |
| `lastAuthenticationStatus` | String? | `SUCCESS` / `FAILED` |
| `lastAuthenticationError` | String? | |
| `lastSuccessfulSyncAt` | DateTime? | drives staleness in health check |
| `syncPaused` | Boolean | default `false` (operator pause / queue control) — **Phase 3** |
| `nextTokenRefreshAt` | DateTime? | **Phase 3** |
| `authenticationDurationMs` | Int? | **Phase 3** |
| `authenticationFailureCount` | Int | default `0` — **Phase 3** |
| `createdAt` / `updatedAt` | DateTime | |
| `deletedAt` | DateTime? | **soft delete** |

**Relations:** `mappings`, `registrations`, `statusSnapshots`, `results`, `syncJobs`,
`apiLogs`; **(Phase 3)** `rateLimit` (→ `WorkspaceRateLimit`, optional 1:1),
`circuitBreaker` (→ `WorkspaceCircuitBreaker`, optional 1:1), `healthSnapshots`
(→ `WorkspaceHealthSnapshot`), `alerts` (→ `SystemAlert`).
**Indexes:** `@@index([subjectCode])`, `@@index([isActive])`.

## 11. `WorkspaceSubjectMapping`
Maps a free-text source subject alias (e.g. "Arabic Reading") to a workspace.

| Field | Type | Notes |
|-------|------|-------|
| `id` | String (uuid) | PK |
| `workspaceId` | String | FK → `FastTestWorkspace` (cascade delete) |
| `subjectId` | String? | FK → `Subject` (optional) |
| `subjectAlias` | String | alias as it appears in the source |
| `aliasNormalized` | String | uppercased/trimmed for matching |
| `isActive` | Boolean | default `true` |
| `createdAt` / `updatedAt` | DateTime | |

**Relations:** `workspace`, `subject`.
**Unique:** `@@unique([aliasNormalized])` — one workspace per normalized alias.
**Indexes:** `@@index([workspaceId])`.

---

## 12. `ExamRegistration`
The core operational entity: one student's registration for one exam/subject, with
its normalized TestCode, resolved workspace, and denormalized latest FastTest status
for fast dashboard reads.

**Source identity & references**

| Field | Type | Notes |
|-------|------|-------|
| `id` | String (uuid) | PK |
| `studentExternalId` | String | source StudentId |
| `studentId` | String? | FK → `Student` |
| `schoolId` | String? | FK → `School` |
| `subjectId` | String? | FK → `Subject` |

**Source exam fields** (kept as source strings, never fabricated):
`examSubject` (raw), `examName?`, `grade?`, `classCode?`, `startDate?`, `endDate?`,
`startTime?`, `endTime?`, `academicYear?`, `proctorCode?`, `accessToken?` (exam
access token from source — not a FastTest session token).

**TestCode**

| Field | Type | Notes |
|-------|------|-------|
| `testCodeOriginal` | String | as received (e.g. `FUJ-290-263-565`) |
| `testCodeNormalized` | String | compact upper form (e.g. `FUJ290263565`) |

**Attendance:** `attendanceOriginal?` — source value, **never overwritten** by sync.

**Workspace resolution:** `workspaceId?` (FK → `FastTestWorkspace`).

**Denormalized FastTest status / sync bookkeeping**

| Field | Type | Notes |
|-------|------|-------|
| `fastTestStatus` | String? | raw FastTest status (NEW/INPROGRESS/…) |
| `dashboardStatus` | String | normalized, default `UNKNOWN` |
| `fastTestTestId` / `fastTestTestName` / `fastTestExamineeId` / `fastTestRegistrationDate` | String? | denormalized from status |
| `actualStartTime` | String? | denormalized from results |
| `secondsUsed` | Int? | denormalized from results |
| `lastSyncAt` | DateTime? | |
| `syncStatus` | String | `PENDING` / `OK` / `ERROR` / `MANUAL_REVIEW` (default `PENDING`) |
| `syncError` | String? | |
| `syncRetryCount` | Int | default `0` |
| `nextSyncAt` | DateTime? | next scheduled poll (null = not scheduled) |
| `syncState` | String | default `PENDING` — formal state-machine state (`src/lib/sync-state.ts`) — **Phase 3** |
| `syncPriority` | Int | default `100` (lower = higher priority) — **Phase 3** |
| `lastSuccessfulSyncAt` | DateTime? | **Phase 3** |
| `isStale` | Boolean | default `false` — stale-data detection (computed by scheduler) — **Phase 3** |
| `staleSince` | DateTime? | **Phase 3** |
| `staleReason` | String? | **Phase 3** |
| `staleSeverity` | String? | `LOW` / `MEDIUM` / `HIGH` — **Phase 3** |
| `createdAt` / `updatedAt` | DateTime | |
| `deletedAt` | DateTime? | **soft delete** |

**Relations:** `student`, `school`, `subject`, `workspace`, `statusSnapshots`,
`results`, `syncJobs`; **(Phase 3)** `stateTransitions` (→ `SyncStateTransition`).

**Unique constraints**
- `@@unique([workspaceId, testCodeNormalized])` — name `uq_workspace_testcode`
- `@@unique([studentExternalId, examSubject, testCodeNormalized])` — name
  `uq_source_identity`

**Indexes:** `dashboardStatus`, `schoolId`, `subjectId`, `workspaceId`,
`syncStatus`, `nextSyncAt`, `testCodeNormalized`; **(Phase 3)**
`@@index([syncState])`, `@@index([isStale])`.

### Uniqueness rationale
The same TestCode can legitimately appear across different subjects/workspaces, so
the *primary* uniqueness key is **`(workspaceId, testCodeNormalized)`** — a TestCode
is unique within the FastTest workspace that serves it. However, a registration may
be imported before its workspace has been resolved (`workspaceId` null), so a second
key **`(studentExternalId, examSubject, testCodeNormalized)`** guarantees source
identity is unique even when the workspace is unknown. The import upsert matches on
this source-identity triple; sync later binds the resolved `workspaceId`.
Normalization (hyphen/space stripping + uppercasing) ensures `FUJ-290-263-565` and
`FUJ290263565` collapse to the same key.

---

## 13. `FastTestStatusSnapshot`
Append-only history: one row per successful status fetch, keeping the full raw
payload. Never discarded.

| Field | Type | Notes |
|-------|------|-------|
| `id` | String (uuid) | PK |
| `registrationId` | String | FK → `ExamRegistration` (cascade delete) |
| `workspaceId` | String | FK → `FastTestWorkspace` (cascade delete) |
| `status` | String | raw FastTest status |
| `dashboardStatus` | String | normalized |
| `testId` / `testName` / `firstName` / `lastName` / `externalId` / `examineeId` / `registrationDate` | String? | parsed from payload |
| `rawJson` | String | full response payload |
| `fetchedAt` | DateTime | default `now()` |

**Relations:** `registration`, `workspace`.
**Indexes:** `@@index([registrationId])`, `@@index([fetchedAt])`.

## 14. `FastTestResult`
Parsed results for a registration (replaced transactionally on each results fetch for
idempotency). Includes derived/calculated fields.

| Field | Type | Notes |
|-------|------|-------|
| `id` | String (uuid) | PK |
| `registrationId` | String | FK → `ExamRegistration` (cascade delete) |
| `workspaceId` | String | FK → `FastTestWorkspace` (cascade delete) |
| `firstName` / `lastName` / `externalId` / `examineeId` / `email` / `registrationDate` | String? | examinee identity |
| `testName` / `startTime` | String? | |
| `secondsUsed` | Int? | |
| `passed` | Boolean? | |
| `testSessionId` / `testSessionName` / `examineeGroupId` / `examineeGroupPath` / `constructorUrl` | String? | session context |
| `attemptedItems` / `totalItemsCount` | Int? | **calculated** (correct+incorrect / +skipped) |
| `completionPercentage` | Float? | **calculated** |
| `durationFormatted` | String? | **calculated** (HH:MM:SS) |
| `startDate` / `startTimeOnly` | String? | **calculated** (split from startTime) |
| `rawScore` / `scaledScore` / `sumScore` / `cutScore` | Float? | **denormalized primary-score summary** (Phase 2) |
| `correctCount` / `incorrectCount` / `skippedCount` | Int? | **denormalized primary-score summary** (Phase 2) |
| `schoolId` / `subjectId` / `grade` / `examSubject` | String? | **denormalized analytics dimensions** (Phase 2) |
| `rawJson` | String | complete raw results payload |
| `lastSyncAt` | DateTime | default `now()` |
| `syncStatus` | String | default `OK` |
| `syncError` | String? | |
| `syncRetryCount` | Int | default `0` |
| `createdAt` / `updatedAt` | DateTime | |

**Relations:** `registration`, `workspace`, `scores` (→ `FastTestScore`).
**Indexes:** `@@index([registrationId])`, `@@index([schoolId])`,
`@@index([subjectId])`.

> **Phase 2 denormalization.** The primary-score columns
> (`rawScore`/`scaledScore`/`sumScore`/`cutScore`/`correctCount`/`incorrectCount`/`skippedCount`)
> and the dimension columns (`schoolId`/`subjectId`/`grade`/`examSubject`) are
> copied onto each result row so per-school and per-subject analytics run as a
> single indexed `groupBy` (using the `schoolId`/`subjectId` indexes) instead of
> joining through `FastTestScore` and `ExamRegistration` on every dashboard query.
> The per-subscore detail still lives in `FastTestScore` (§15). Added by migration
> `20260713070938_phase2_analytics`.

## 15. `FastTestScore`
Per-subscore breakdown for a result (raw/scaled scores and correct/incorrect/skipped
item counts).

| Field | Type | Notes |
|-------|------|-------|
| `id` | String (uuid) | PK |
| `resultId` | String | FK → `FastTestResult` (cascade delete) |
| `examineeTestId` / `subscore` / `name` | String? | |
| `rawScore` / `sumScore` / `cutScore` / `scaledScore` | Float? | |
| `correct` / `incorrect` / `skipped` | Int? | scoredItems breakdown |
| `totalCorrect` / `totalIncorrect` / `totalSkipped` | Int? | totalItems breakdown |
| `rawJson` | String | raw score payload |
| `createdAt` | DateTime | |

**Relations:** `result`.
**Indexes:** `@@index([resultId])`.

---

## 16. `SyncJob`
Durable DB-backed queue job. **Phase 3 rewrote and expanded this model** (migration
`20260713080816_phase3_durable_sync`); it replaces the earlier status/results-only
orchestration record and carries the full set of scheduling, retry, locking, and
error-classification fields needed for a Redis-free queue.

| Field | Type | Notes |
|-------|------|-------|
| `id` | String (uuid) | PK |
| `jobType` | String | `JOB_TYPE.*`: `AUTHENTICATE_WORKSPACE`, `SYNC_REGISTRATION_STATUS`, `SYNC_REGISTRATION_RESULTS`, `SYNC_REGISTRATION_FULL`, `SYNC_WORKSPACE_BATCH`, `SYNC_SCHOOL_BATCH`, `SYNC_SUBJECT_BATCH`, `SYNC_ACTIVE_EXAMS`, `REFRESH_ATTENTION_ITEMS`, `REFRESH_ANALYTICS_CACHE`, `RETRY_FAILED_SYNC`, `MANUAL_SYNC` |
| `priority` | Int | default `100` (lower = higher priority) |
| `workspaceId` | String? | FK → `FastTestWorkspace` |
| `registrationId` | String? | FK → `ExamRegistration` (cascade delete) |
| `testCodeNormalized` | String? | |
| `subject` | String? | |
| `schoolId` | String? | |
| `payload` | String? | JSON; **MUST NOT contain secrets** |
| `status` | String | default `QUEUED` — `QUEUED` / `RUNNING` / `DONE` / `FAILED` / `RETRY_SCHEDULED` / `DEAD_LETTER` / `CANCELLED` / `MANUAL_REVIEW` |
| `scheduledAt` | DateTime | default `now()` |
| `startedAt` | DateTime? | |
| `completedAt` | DateTime? | |
| `attemptCount` | Int | default `0` |
| `maxAttempts` | Int | default `3` |
| `nextRetryAt` | DateTime? | |
| `lockedBy` | String? | worker id currently holding the job |
| `lockedAt` | DateTime? | |
| `heartbeatAt` | DateTime? | |
| `lastErrorCode` | String? | |
| `lastErrorMessage` | String? | |
| `dedupeKey` | String? | active-job dedup, enforced in code within a tx |
| `correlationId` | String? | |
| `createdBy` | String? | actor email or `SYSTEM` |
| `createdAt` / `updatedAt` | DateTime | |

**Relations:** `registration`, `workspace`, `attempts` (→ `SyncJobAttempt`).
**Indexes:** `@@index([status, priority, scheduledAt])`,
`@@index([status, nextRetryAt])`, `@@index([registrationId])`,
`@@index([workspaceId, status])`, `@@index([jobType, status])`,
`@@index([dedupeKey])`, `@@index([lockedBy])`.

> **Atomic claim.** A job is claimed atomically via a guarded `updateMany`
> (status + lock guard), so only one worker ever processes it — no Redis needed.

## 17. `SyncJobAttempt`
One attempt of a `SyncJob`, capturing outcome, error classification, and timing.
**Phase 3 replaces the earlier `SyncAttempt` model.**

| Field | Type | Notes |
|-------|------|-------|
| `id` | String (uuid) | PK |
| `jobId` | String | FK → `SyncJob` (cascade delete) |
| `attemptNumber` | Int | |
| `workerId` | String? | |
| `endpoint` | String? | |
| `status` | String | `SUCCESS` / `FAILURE` |
| `errorCategory` | String? | `ERROR_CATEGORY.*` |
| `errorCode` | String? | |
| `errorMessage` | String? | |
| `httpStatus` | Int? | |
| `durationMs` | Int? | |
| `correlationId` | String? | |
| `startedAt` | DateTime | default `now()` |
| `finishedAt` | DateTime? | |

**Relations:** `job`.
**Indexes:** `@@index([jobId])`, `@@index([startedAt])`.

---

## 18. `ApiRequestLog`
Every outbound FastTest call, for API monitoring and health.

| Field | Type | Notes |
|-------|------|-------|
| `id` | String (uuid) | PK |
| `workspaceId` | String? | FK → `FastTestWorkspace` |
| `endpoint` | String | e.g. `/tests/registration/{code}/status` |
| `method` | String | HTTP method |
| `requestedAt` | DateTime | default `now()` |
| `respondedAt` | DateTime? | |
| `responseTimeMs` | Int? | latency |
| `httpStatus` | Int? | |
| `fastTestErrorCode` / `fastTestErrorMessage` | String? | parsed from body |
| `retryCount` | Int | default `0` |
| `success` | Boolean | default `false` |
| `correlationId` | String? | |

**Relations:** `workspace`.
**Indexes:** `@@index([workspaceId])`, `@@index([requestedAt])`,
`@@index([success])`.

## 19. `AuditLog`
User/action audit trail. `detail` must never contain secrets.

| Field | Type | Notes |
|-------|------|-------|
| `id` | String (uuid) | PK |
| `userId` | String? | FK → `User` |
| `actorEmail` | String? | |
| `action` | String | `LOGIN` / `LOGOUT` / `LOGIN_FAILED` / `IMPORT` / `MANUAL_SYNC` / `EXPORT` / `CONFIG_CHANGE` / … |
| `entityType` / `entityId` | String? | affected entity |
| `detail` | String? | human-readable (no secrets) |
| `ipAddress` | String? | |
| `createdAt` | DateTime | default `now()` |

**Relations:** `user`.
**Indexes:** `@@index([userId])`, `@@index([action])`, `@@index([createdAt])`.

## 20. `SystemSetting`
Simple key/value settings store.

| Field | Type | Notes |
|-------|------|-------|
| `key` | String | **PK** |
| `value` | String | |
| `updatedAt` | DateTime | |

---

## 21. `ImportJob`
Header record for a CSV/XLSX import, with row counts and a summary snapshot.

| Field | Type | Notes |
|-------|------|-------|
| `id` | String (uuid) | PK |
| `userId` | String? | FK → `User` |
| `fileName` | String | |
| `status` | String | `PENDING` / `PREVIEW` / `CONFIRMED` / `COMPLETED` / `FAILED` (default `PENDING`) |
| `totalRows` | Int | default `0` |
| `createdCount` / `updatedCount` / `skippedCount` / `failedCount` | Int | default `0` |
| `summaryJson` | String? | preview/summary snapshot |
| `createdAt` / `updatedAt` | DateTime | |

**Relations:** `user`, `errors` (→ `ImportError`).
**Indexes:** `@@index([status])`.

## 22. `ImportError`
A single validation or upsert error within an import job (downloadable as CSV).

| Field | Type | Notes |
|-------|------|-------|
| `id` | String (uuid) | PK |
| `importJobId` | String | FK → `ImportJob` (cascade delete) |
| `rowNumber` | Int | 1-based source row |
| `column` | String? | offending column |
| `value` | String? | offending value |
| `message` | String | error description |
| `createdAt` | DateTime | default `now()` |

**Relations:** `importJob`.
**Indexes:** `@@index([importJobId])`.

---

## Phase 2 — Analytics & Operational models

Added by migration `20260713070938_phase2_analytics`.

## 23. `SavedView`
A user-defined, reusable filter / sort / column configuration for a page.

| Field | Type | Notes |
|-------|------|-------|
| `id` | String (uuid) | PK |
| `userId` | String | FK → `User` (cascade delete); owner/creator |
| `name` | String | |
| `description` | String? | |
| `pageType` | String | `registrations` / `schools` / `subjects` / `attention` |
| `filtersJson` | String | serialized filter object (default `"{}"`) |
| `sortBy` | String? | |
| `sortDir` | String? | `asc` / `desc` |
| `columnsJson` | String | visible columns, in order (default `"[]"`) |
| `pageSize` | Int | default `25` |
| `isDefault` | Boolean | default `false` (one default per user/page) |
| `isShared` | Boolean | default `false` (visible to all users; admin-created) |
| `createdAt` / `updatedAt` | DateTime | |
| `deletedAt` | DateTime? | **soft delete** |

**Relations:** `user` (relation name `UserSavedViews`).
**Indexes:** `@@index([userId, pageType])`, `@@index([isShared])`.

## 24. `UserTablePreference`
Per-user default column configuration for a page, independent of saved views.

| Field | Type | Notes |
|-------|------|-------|
| `id` | String (uuid) | PK |
| `userId` | String | FK → `User` (cascade delete) |
| `pageType` | String | |
| `columnsJson` | String | serialized column list (default `"[]"`) |
| `pageSize` | Int | default `25` |
| `createdAt` / `updatedAt` | DateTime | |

**Relations:** `user` (relation name `UserTablePrefs`).
**Unique:** `@@unique([userId, pageType])` — one preference row per user per page
(the service upserts on this key).

## 25. `ExportJob`
Export request history / audit record.

| Field | Type | Notes |
|-------|------|-------|
| `id` | String (uuid) | PK |
| `userId` | String? | FK → `User` |
| `exportType` | String | preset key (e.g. `ALL`, `CURRENT_FILTER`, `COMPLETED`, …) |
| `format` | String | `csv` / `xlsx` |
| `filtersJson` | String | serialized filter (default `"{}"`) |
| `recordCount` | Int | default `0` |
| `status` | String | `PENDING` / `COMPLETED` / `FAILED` (default `PENDING`) |
| `failureReason` | String? | |
| `startedAt` | DateTime | default `now()` |
| `completedAt` | DateTime? | |
| `createdBy` | String? | actor email snapshot |

**Relations:** `user` (relation name `UserExportJobs`).
**Indexes:** `@@index([userId])`, `@@index([status])`, `@@index([startedAt])`.

## 26. `AttentionItem`
An operational queue item for a registration requiring attention.

| Field | Type | Notes |
|-------|------|-------|
| `id` | String (uuid) | PK |
| `registrationId` | String | FK → `ExamRegistration` (cascade delete) |
| `schoolId` | String? | denormalized for scope/filtering |
| `subjectId` | String? | denormalized for filtering |
| `issueType` | String | one of the 10 `ATTENTION_ISSUE.*` types |
| `severity` | String | `HIGH` / `MEDIUM` / `LOW` |
| `status` | String | `OPEN` / `ACKNOWLEDGED` / `RESOLVED` (default `OPEN`) |
| `lastError` | String? | |
| `retryCount` | Int | default `0` |
| `detail` | String? | |
| `assignedToUserId` | String? | FK → `User` (relation `UserAttentionAssigned`) |
| `resolvedAt` | DateTime? | |
| `resolvedBy` | String? | actor email, or `SYSTEM` on auto-resolve |
| `firstDetectedAt` / `lastDetectedAt` | DateTime | default `now()` |
| `createdAt` / `updatedAt` | DateTime | |

**Relations:** `registration`, `assignedTo` (→ `User`), `notes`
(→ `AttentionNote`).
**Unique:** `@@unique([registrationId, issueType])` — one item per
(registration, issue); `refreshAttention` upserts on this key so recomputation is
idempotent.
**Indexes:** `@@index([status, severity])`, `@@index([schoolId])`,
`@@index([issueType])`.

## 27. `AttentionNote`
An operator note attached to an attention item.

| Field | Type | Notes |
|-------|------|-------|
| `id` | String (uuid) | PK |
| `attentionItemId` | String | FK → `AttentionItem` (cascade delete) |
| `authorUserId` | String? | FK → `User` (relation `UserAttentionNotes`) |
| `authorEmail` | String? | |
| `note` | String | |
| `createdAt` | DateTime | default `now()` |

**Relations:** `item` (→ `AttentionItem`), `author` (→ `User`).
**Indexes:** `@@index([attentionItemId])`.

---

## Phase 3 — Durable sync platform models

Added by migration `20260713080816_phase3_durable_sync`. These models turn sync into
a durable, DB-backed queue with worker health tracking, per-workspace rate limiting
and circuit breaking, operational alerting, and periodic metric/health snapshots.
The durable queue job (`SyncJob`, §16) and its per-attempt record (`SyncJobAttempt`,
§17) are documented above; the 13 new/expanded Phase 3 models are listed here in the
model index as §28–§40.

### `SyncStateTransition`
Persisted history of a registration's sync-state-machine transitions.

| Field | Type | Notes |
|-------|------|-------|
| `id` | String (uuid) | PK |
| `registrationId` | String | FK → `ExamRegistration` (cascade delete) |
| `jobId` | String? | |
| `fromState` | String | |
| `toState` | String | |
| `reason` | String? | |
| `correlationId` | String? | |
| `createdAt` | DateTime | default `now()` |

**Relations:** `registration`.
**Indexes:** `@@index([registrationId])`, `@@index([createdAt])`.

### `WorkerInstance`
A registered worker process, for health monitoring and stalled-job recovery.

| Field | Type | Notes |
|-------|------|-------|
| `id` | String | **PK** — worker id (e.g. `worker-<host>-<pid>-<rand>`) |
| `hostname` | String? | |
| `pid` | Int? | |
| `version` | String? | |
| `status` | String | default `HEALTHY` — `HEALTHY` / `DEGRADED` / `STALE` / `OFFLINE` |
| `startedAt` | DateTime | default `now()` |
| `lastHeartbeatAt` | DateTime | default `now()` |
| `currentJobs` | Int | default `0` |
| `jobsCompleted` | Int | default `0` |
| `jobsFailed` | Int | default `0` |
| `avgJobDurationMs` | Int | default `0` |
| `memoryMb` | Int? | |
| `cpuPercent` | Float? | |
| `stoppedAt` | DateTime? | |
| `updatedAt` | DateTime | `@updatedAt` |

**Relations:** `heartbeats` (→ `WorkerHeartbeat`).
**Indexes:** `@@index([status])`, `@@index([lastHeartbeatAt])`.

### `WorkerHeartbeat`
A periodic heartbeat sample emitted by a worker.

| Field | Type | Notes |
|-------|------|-------|
| `id` | String (uuid) | PK |
| `workerId` | String | FK → `WorkerInstance` (cascade delete) |
| `status` | String | |
| `currentJobs` | Int | default `0` |
| `memoryMb` | Int? | |
| `cpuPercent` | Float? | |
| `createdAt` | DateTime | default `now()` |

**Relations:** `worker`.
**Indexes:** `@@index([workerId, createdAt])`.

### `DistributedLock`
General-purpose distributed lock with owner + expiry + heartbeat + read-after-write
takeover verification (used for token refresh).

| Field | Type | Notes |
|-------|------|-------|
| `key` | String | **PK** — e.g. `token:<workspaceId>` or `reg:<registrationId>` |
| `owner` | String | |
| `acquiredAt` | DateTime | default `now()` |
| `heartbeatAt` | DateTime | default `now()` |
| `expiresAt` | DateTime | |

**Indexes:** `@@index([expiresAt])`.

### `WorkspaceRateLimit`
Per-workspace rate-limit configuration (optional 1:1 with `FastTestWorkspace`).
Conservative per-workspace defaults; FastTest limits are **not** assumed.

| Field | Type | Notes |
|-------|------|-------|
| `workspaceId` | String | **PK** — FK → `FastTestWorkspace` (cascade delete), 1:1 |
| `maxRps` | Float | default `2` |
| `maxRpm` | Int | default `60` |
| `maxConcurrent` | Int | default `3` |
| `maxBatch` | Int | default `25` |
| `minDelayMs` | Int | default `200` |
| `burst` | Int | default `5` |
| `cooldownMs` | Int | default `30000` |
| `authMaxConcurrent` | Int? | per-endpoint concurrency override (null → inherit `maxConcurrent`) |
| `statusMaxConcurrent` | Int? | per-endpoint concurrency override (null → inherit `maxConcurrent`) |
| `resultsMaxConcurrent` | Int? | per-endpoint concurrency override (null → inherit `maxConcurrent`) |
| `updatedAt` | DateTime | `@updatedAt` |

**Relations:** `workspace`.

### `WorkspaceCircuitBreaker`
Per-workspace circuit-breaker state (optional 1:1 with `FastTestWorkspace`).

| Field | Type | Notes |
|-------|------|-------|
| `workspaceId` | String | **PK** — FK → `FastTestWorkspace` (cascade delete), 1:1 |
| `state` | String | default `CLOSED` — `CLOSED` / `OPEN` / `HALF_OPEN` |
| `failureCount` | Int | default `0` |
| `successCount` | Int | default `0` |
| `openedAt` | DateTime? | |
| `nextProbeAt` | DateTime? | |
| `lastTrippedReason` | String? | |
| `updatedAt` | DateTime | `@updatedAt` |

**Relations:** `workspace`.

### `SystemAlert`
An internal operational alert.

| Field | Type | Notes |
|-------|------|-------|
| `id` | String (uuid) | PK |
| `alertType` | String | `ALERT_TYPE.*` |
| `severity` | String | `LOW` / `MEDIUM` / `HIGH` / `CRITICAL` |
| `status` | String | default `OPEN` — `OPEN` / `ACKNOWLEDGED` / `RESOLVED` |
| `workspaceId` | String? | FK → `FastTestWorkspace` |
| `title` | String | |
| `detail` | String? | |
| `dedupeKey` | String? | **unique** — one open alert per condition |
| `assignedToUserId` | String? | FK → `User` (relation `UserAlertsAssigned`) |
| `acknowledgedAt` | DateTime? | |
| `resolvedAt` | DateTime? | |
| `resolvedBy` | String? | |
| `firstSeenAt` | DateTime | default `now()` |
| `lastSeenAt` | DateTime | default `now()` |
| `occurrences` | Int | default `1` |
| `createdAt` / `updatedAt` | DateTime | |

**Relations:** `workspace`, `assignedTo` (→ `User`), `notes` (→ `AlertNote`).
**Unique:** field-level `@unique` on `dedupeKey`.
**Indexes:** `@@index([status, severity])`, `@@index([alertType])`.

### `AlertNote`
An operator note attached to a `SystemAlert`.

| Field | Type | Notes |
|-------|------|-------|
| `id` | String (uuid) | PK |
| `alertId` | String | FK → `SystemAlert` (cascade delete) |
| `authorUserId` | String? | FK → `User` (relation `UserAlertNotes`) |
| `authorEmail` | String? | |
| `note` | String | |
| `createdAt` | DateTime | default `now()` |

**Relations:** `alert`, `author` (→ `User`).
**Indexes:** `@@index([alertId])`.

### `QueueMetricSnapshot`
A periodic snapshot of queue KPIs (standalone).

| Field | Type | Notes |
|-------|------|-------|
| `id` | String (uuid) | PK |
| `queuedJobs` | Int | default `0` |
| `runningJobs` | Int | default `0` |
| `retryScheduled` | Int | default `0` |
| `deadLetterJobs` | Int | default `0` |
| `completedLastMin` | Int | default `0` |
| `failedLastMin` | Int | default `0` |
| `oldestJobAgeMs` | Int | default `0` |
| `activeWorkers` | Int | default `0` |
| `staleRegistrations` | Int | default `0` |
| `createdAt` | DateTime | default `now()` |

**Indexes:** `@@index([createdAt])`.

### `WorkspaceHealthSnapshot`
A periodic per-workspace health snapshot.

| Field | Type | Notes |
|-------|------|-------|
| `id` | String (uuid) | PK |
| `workspaceId` | String | FK → `FastTestWorkspace` (cascade delete) |
| `circuitState` | String | |
| `avgResponseMs` | Int | default `0` |
| `p95ResponseMs` | Int | default `0` |
| `errorRate` | Float | default `0` |
| `requestCount` | Int | default `0` |
| `staleCount` | Int | default `0` |
| `createdAt` | DateTime | default `now()` |

**Relations:** `workspace`.
**Indexes:** `@@index([workspaceId, createdAt])`.

### `QueueControl`
Pause/resume control for a workspace or job type (standalone).

| Field | Type | Notes |
|-------|------|-------|
| `id` | String (uuid) | PK |
| `scope` | String | `WORKSPACE` / `JOB_TYPE` |
| `scopeKey` | String | workspaceId or jobType value |
| `paused` | Boolean | default `false` |
| `reason` | String? | |
| `updatedBy` | String? | |
| `updatedAt` | DateTime | `@updatedAt` |

**Unique:** `@@unique([scope, scopeKey])`.

---

## Soft-delete usage

`deletedAt` marks a row as logically removed without physical deletion. It is present
on **`User`, `School`, `Student`, `FastTestWorkspace`, `ExamRegistration`, and
(Phase 2) `SavedView`**.
Application queries consistently filter `deletedAt: null` (e.g. the sync worker's
`selectDue`, workspace resolution, analytics reads, and detail lookups), so
soft-deleted rows disappear from the dashboard and from polling while their history
(snapshots, results, logs) is retained.

---

## ER-style relationship summary

```
User 1───* UserRole *───1 Role 1───* RolePermission *───1 Permission
User 1───* UserSchoolScope *───1 School
User 1───* AuditLog
User 1───* ImportJob 1───* ImportError
User 1───* SavedView                     (Phase 2)
User 1───* UserTablePreference           (Phase 2)
User 1───* ExportJob                     (Phase 2)
User 1───* AttentionItem  (assignedTo)   (Phase 2)
User 1───* AttentionNote  (author)       (Phase 2)

School   1───* Student
School   1───* ExamRegistration
Subject  1───* ExamRegistration
Subject  1───* WorkspaceSubjectMapping
Student  1───* ExamRegistration

FastTestWorkspace 1───* WorkspaceSubjectMapping
FastTestWorkspace 1───* ExamRegistration
FastTestWorkspace 1───* FastTestStatusSnapshot
FastTestWorkspace 1───* FastTestResult
FastTestWorkspace 1───* SyncJob
FastTestWorkspace 1───* ApiRequestLog

ExamRegistration 1───* FastTestStatusSnapshot
ExamRegistration 1───* FastTestResult 1───* FastTestScore
ExamRegistration 1───* SyncJob 1───* SyncJobAttempt
ExamRegistration 1───* SyncStateTransition          (Phase 3)
ExamRegistration 1───* AttentionItem 1───* AttentionNote   (Phase 2)

FastTestWorkspace 1───1 WorkspaceRateLimit          (Phase 3)
FastTestWorkspace 1───1 WorkspaceCircuitBreaker      (Phase 3)
FastTestWorkspace 1───* WorkspaceHealthSnapshot      (Phase 3)
FastTestWorkspace 1───* SystemAlert                  (Phase 3)
WorkerInstance    1───* WorkerHeartbeat              (Phase 3)
SystemAlert       1───* AlertNote                    (Phase 3)
User              1───* SystemAlert (assignedTo)     (Phase 3)
User              1───* AlertNote   (author)         (Phase 3)

SystemSetting          (standalone key/value)
QueueMetricSnapshot    (standalone)                  (Phase 3)
QueueControl           (standalone)                  (Phase 3)
DistributedLock        (standalone)                  (Phase 3)
```

**Cardinality highlights**
- A `User` has many roles (via `UserRole`); a `Role` grants many permissions (via
  `RolePermission`) — a classic RBAC many-to-many pair.
- A `SCHOOL_USER` is scoped to schools via `UserSchoolScope`.
- A `FastTestWorkspace` serves one subject but many aliases (`WorkspaceSubjectMapping`)
  and owns all integration artifacts (registrations, snapshots, results, sync jobs,
  API logs).
- `ExamRegistration` is the hub: it links a student, school, subject, and workspace,
  and fans out to status snapshots, results (each with scores), and sync jobs (each
  with attempts).
- Deleting a `FastTestResult` cascades to its `FastTestScore` rows; deleting a
  `SyncJob` cascades to its `SyncAttempt` rows; join-table and child rows cascade
  from their parents as annotated in the schema.
