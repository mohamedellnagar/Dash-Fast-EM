# FastTest Dashboard — Metrics Dictionary

Exact definitions, formulas and data sources for every KPI and chart on the dashboard. Every formula below is
verified against `src/services/dashboard.service.ts` (Phase-2 analytics) and `src/services/analytics.service.ts`
(Phase-1 executive KPIs). Aggregation runs **in the database**; nothing is computed in the browser.

---

## Core principles

1. **Single source of truth for filtering.** Every KPI and every table cell is computed from the *same*
   pre-built `ExamRegistration` where-clause (`buildRegistrationWhere(filter, scopeSchoolIds)`), with school
   scoping already applied by the caller. Result-based metrics filter through the registration relation
   (`resultWhere(where) = { registration: { is: where } }`) so the **same filter applies to results**. This
   guarantees KPIs always match the filtered registrations table.

2. **Null-handling contract (strict — do not violate):**
   - **Averages over zero results return `null`, and render as `"N/A"` — never `0`.**
     `round2(null) === null`; the display layer (`columns.ts` `display()`) maps `null → "N/A"`.
   - `avgTimeUsedSeconds` is `Math.round(avg)` only when the average is non-null; otherwise `null`.
   - **`Passed` is never inferred from a null value.** Absence of a result is not a fail.
   - **`DateCompleted` / `TimeCompleted` are never fabricated.** Missing completion timestamps stay null
     and render as `"N/A"`; they are not back-filled or guessed.
   - Raw column getters (`columns.ts`) return the raw value or `null`; callers never coerce `null` to `0`.

3. **Denormalized result fields.** Score/count/duration metrics read denormalized fields on
   `FastTestResult` (`rawScore`, `scaledScore`, `secondsUsed`, `correctCount`, `incorrectCount`,
   `skippedCount`, `completionPercentage`) rather than re-deriving them, so aggregation stays in-DB and fast.

4. **Rounding helper.** `round2(n) = Math.round(n * 100) / 100` (2 decimals), returning `null` for `null`/
   `undefined` input.

---

## KPI definitions

Source function: `kpiBlock(where)` in `dashboard.service.ts` (used by overview, school detail, subject detail).
`overview(where)` wraps `kpiBlock` and adds the API/workspace fields.

| Metric | Formula | Data source | Null / edge behaviour |
|--------|---------|-------------|-----------------------|
| **Total Registered** | `SUM` of grouped `dashboardStatus` counts over filtered registrations | `groupBy(dashboardStatus)` on `ExamRegistration` (`statusCounts`) | 0 when no rows |
| **Per-status counts** (`NOT_STARTED`, `IN_PROGRESS`, `COMPLETED`, `UNDER_REVIEW`, `REVIEW_FAILED`, `UNKNOWN`) | count per `dashboardStatus` group | same groupBy; missing statuses default to `0` (`EMPTY_STATUS`) | absent status = 0 |
| **Completion Rate** | `COMPLETED / Total × 100`, then `round2` | derived from status counts | `0` when `Total = 0` |
| **Avg Time Used (s)** | `AVG(FastTestResult.secondsUsed)`, then `Math.round` | `fastTestResult.aggregate(_avg.secondsUsed)` over `resultWhere(where)` | **`null` (→ "N/A") when no results** |
| **Avg Completion %** | `round2(AVG(FastTestResult.completionPercentage))` | `_avg.completionPercentage` | `null` when no results |
| **Avg Raw Score** | `round2(AVG(FastTestResult.rawScore))` | `_avg.rawScore` (denormalized) | `null` when no results |
| **Avg Scaled Score** | `round2(AVG(FastTestResult.scaledScore))` | `_avg.scaledScore` (denormalized) | `null` when no results |
| **Correct** | `SUM(FastTestResult.correctCount)` | `_sum.correctCount`, `?? 0` | 0 when no results |
| **Incorrect** | `SUM(FastTestResult.incorrectCount)` | `_sum.incorrectCount`, `?? 0` | 0 |
| **Skipped** | `SUM(FastTestResult.skippedCount)` | `_sum.skippedCount`, `?? 0` | 0 |
| **Sync Errors** | count of filtered registrations with `syncStatus ∈ {ERROR, MANUAL_REVIEW}` | `examRegistration.count` ANDed with the same `where` | 0 |

### Derived counts (per-row, `columns.ts`)

| Column | Source |
|--------|--------|
| **Attempted** | `FastTestResult.attemptedItems` (denormalized; = Correct + Incorrect) |
| **Total Items** | `FastTestResult.totalItemsCount` (denormalized; = Correct + Incorrect + Skipped) |
| **Completion %** | `FastTestResult.completionPercentage` |

> "Attempted" conceptually equals Correct + Incorrect, and "Total Items" equals Correct + Incorrect + Skipped;
> the app reads the denormalized `attemptedItems` / `totalItemsCount` fields directly rather than recomputing.
> All per-row numeric getters return `null` (→ "N/A") when the underlying result value is absent.

---

## Executive / overview-only metrics

Added by `overview(where)` on top of `kpiBlock`. **API-health metrics are global** (not filtered by the
registration where-clause — they aggregate the whole `ApiRequestLog`).

| Metric | Formula | Data source | Edge behaviour |
|--------|---------|-------------|----------------|
| **API Success Rate** | `(total − failed) / total × 100`, `round2` | `ApiRequestLog`: `total = _count._all`, `failed = count(success = false)` | **`100` when `total = 0`** |
| **Avg Response Time (ms)** | `Math.round(AVG(ApiRequestLog.responseTimeMs))` | `_avg.responseTimeMs`, `?? 0` | `0` when no logs |
| **API Errors** | `count(ApiRequestLog.success = false)` | global `ApiRequestLog` count | 0 |
| **Last Successful Sync At** | most recent `FastTestWorkspace.lastSuccessfulSyncAt` | `findFirst … orderBy lastSuccessfulSyncAt desc` | `null` when none |

> The Phase-1 executive dashboard (`/`, `/api/kpis`) uses `analytics.service.executiveKpis`, which exposes the
> same status counts plus `syncSuccessRate`, `avgResponseTimeMs`, `avgTimeUsedSeconds`, and score averages.
> Note its `avgTimeUsedSeconds` uses `?? 0` (renders `0` rather than "N/A"); the Phase-2 `kpiBlock` used by the
> analytics pages is the stricter, null-preserving version.

---

## Workspace / API health (`apiHealth()`)

Stale threshold constant: `STALE_MS = 15 × 60 × 1000` (15 minutes).

**Per-workspace fields** (`apiHealth().workspaces[]`):

| Field | Formula / source |
|-------|------------------|
| `workspaceId`, `workspaceName`, `subjectCode`, `isActive`, `syncEnabled` | from `FastTestWorkspace` |
| `connectionStatus` | `lastAuthenticationStatus ?? 'UNKNOWN'` |
| `lastAuthenticationAt`, `lastAuthenticationStatus`, `lastAuthenticationError` | from workspace |
| `lastSuccessfulSyncAt` | from workspace |
| **`avgResponseTimeMs`** | `Math.round(AVG(ApiRequestLog.responseTimeMs))` for that workspace, `?? 0` |
| **`apiSuccessRate`** | `(total − fails) / total × 100`, `round2`; **`100` when `total = 0`** |
| **`staleDataCount`** | count of that workspace's non-deleted registrations where `lastSyncAt IS NULL` **or** `lastSyncAt < now − 15 min` |

**Aggregate fields:** `responseTimeTrend` (last 50 `ApiRequestLog` rows, chronological: `{ at, ms, success }`),
`errorDistribution` (`groupBy(fastTestErrorCode)` over failed requests: `{ code, count }`, `code` defaults to
`UNKNOWN`).

**Stale Data Count** (definition): a registration is *stale* when its `lastSyncAt` is null **or** older than
15 minutes. The same rule appears in `/health/fasttest`, where a workspace is `stale` if `lastSuccessfulSyncAt`
is null or older than 15 minutes.

---

## Per-dimension breakdowns

| Function | Grouping | Emits per group | Sort |
|----------|----------|-----------------|------|
| `statusDistribution(where)` | `dashboardStatus` | `{ counts, total }` | — |
| `schoolsSummary(where)` | `schoolId × dashboardStatus` (+ result & error joins) | `schoolId`, `externalId`, `schoolName`, `total`, status counts, `apiErrors`, `avgTimeUsed`, `avgRawScore`, `avgScaledScore`, `completionRate` | total desc |
| `subjectsSummary(where)` | `examSubject × dashboardStatus` (+ result join) | `examSubject`, `total`, status counts, `avgTimeUsed`, `avgRawScore`, `avgScaledScore`, `correct`, `incorrect`, `skipped`, `completionRate` | total desc |
| `completionByGrade(where)` | `grade × dashboardStatus` | `{ grade, total, completed, completionRate }` | grade asc |
| `durationsBySubject(where)` | result `examSubject` | `{ examSubject, avgSeconds }` | avgSeconds desc |
| `scoresBySubject(where)` | result `examSubject` | `{ examSubject, avgRawScore, avgScaledScore }` | avgRawScore desc |
| `scoresBySchool(where)` | result `schoolId` | `{ schoolId, schoolName, avgRawScore, avgSeconds }` | — |
| `correctIncorrectSkipped(where)` | — | `{ correct, incorrect, skipped }` (sums, `?? 0`) | — |
| `scoreDistribution(where, 20, 100)` | denormalized `rawScore` buckets | buckets `0-20 … 80-100`, plus `100+`; counts | fixed bucket order |
| `completionTrends(where)` | `startDate × dashboardStatus` (non-null `startDate`) | `{ date, total, completed }` | date asc |

**Per-group completion rate** in `schoolsSummary` / `subjectsSummary` / `completionByGrade`:
`Math.round(COMPLETED / total × 100)` (integer %), `0` when `total = 0`. Per-group `avgTimeUsed` / score
averages preserve `null` (→ "N/A") when the group has no results. `scoreDistribution` reads up to 20,000
result rows with non-null `rawScore`; values `≥ 100` land in the `100+` bucket.

---

## Charts per dashboard page

### Executive Dashboard (`/`, renders `dashboard`)

Source: `analytics.service` via the route handler — `executiveKpis`, `registrationsBySubject`,
`completionBySchool`.

| Element | Source function |
|---------|-----------------|
| KPI cards (Total Registered, status counts, completion rate, API/sync rates, avg score/time) | `executiveKpis` |
| Registrations by Subject (status breakdown) | `registrationsBySubject` |
| Completion by School | `completionBySchool` |

### Schools Dashboard (`/schools`, renders `schools`)

All from `dashboard.service.ts` with the shared filtered `where`:

| Element | Source function |
|---------|-----------------|
| KPI block | `kpiBlock` |
| Schools table | `schoolsSummary` |
| Subjects table | `subjectsSummary` |
| Completion by Grade | `completionByGrade` |
| Durations by Subject | `durationsBySubject` |
| Scores by Subject | `scoresBySubject` |
| Completion Trends | `completionTrends` |
| Correct/Incorrect/Skipped | `correctIncorrectSkipped` |
| Status Distribution | `statusDistribution` |
| API error distribution | `apiHealth().errorDistribution` |

### School Detail (`/schools/:id`, renders `school-detail`)

`where` = shared filter + forced `schoolId` (scope-checked → `403`/`404`):

| Element | Source function |
|---------|-----------------|
| KPI block | `kpiBlock` |
| Subjects table | `subjectsSummary` |
| Completion by Grade | `completionByGrade` |
| Completion Trends | `completionTrends` |
| Correct/Incorrect/Skipped | `correctIncorrectSkipped` |
| Status Distribution | `statusDistribution` |
| Students (paginated registrations, 25/page) | `listRegistrationsWhere` |

### Subject Dashboard (`/subjects`, renders `subjects`)

| Element | Source function |
|---------|-----------------|
| Subjects table | `subjectsSummary` |
| Workspaces panel | `apiHealth().workspaces` |

### Subject Detail (`/subjects/:subject`, renders `subject-detail`)

`where` = shared filter + forced `examSubject` (URI-decoded):

| Element | Source function |
|---------|-----------------|
| KPI block | `kpiBlock` |
| Schools table | `schoolsSummary` |
| Completion by Grade | `completionByGrade` |
| Scores by School | `scoresBySchool` |
| Durations by Subject | `durationsBySubject` |
| Score Distribution | `scoreDistribution` |
| Completion Trends | `completionTrends` |
| Correct/Incorrect/Skipped | `correctIncorrectSkipped` |
| Status Distribution | `statusDistribution` |
| Workspace health (this subject) | `workspaceHealthForSubject` |

> `workspaceHealthForSubject(examSubject)` matches on `subjectCode` (upper-cased; also tries spaces→underscores)
> and returns `null` when no workspace matches — again, no fabricated data.

---

## Dashboard status vocabulary

Normalized `dashboardStatus` values (`DASHBOARD_STATUS`, `src/lib/enums.ts`), mapped from raw FastTest statuses
by `toDashboardStatus`:

| Dashboard status | Raw FastTest source |
|------------------|---------------------|
| `NOT_STARTED` | `NEW` |
| `IN_PROGRESS` | `INPROGRESS` / `IN_PROGRESS` |
| `COMPLETED` | `COMPLETED` |
| `UNDER_REVIEW` | `INREVIEW` |
| `REVIEW_FAILED` | `FAILEDREVIEW` |
| `UNKNOWN` | any unmapped / null raw status |

Sync statuses (`SYNC_STATUS`): `PENDING`, `OK`, `ERROR`, `MANUAL_REVIEW`. "API Errors" / "Sync Failures" KPIs
count registrations in `{ERROR, MANUAL_REVIEW}`.
