# Export Guide

Reports and exports let authorized users pull registration data, summaries, and
the attention queue out of the FastTest Live Monitoring dashboard as spreadsheet
files. This guide documents the export behavior as implemented in
`src/services/export.service.ts` and `src/routes/export.routes.ts`.

## Access and permission

Every export endpoint is gated by the `export:run` permission
(`PERMISSION.EXPORT_RUN`). A user without it cannot reach any export route.

By default role (`src/services/rbac.service.ts`), `export:run` is granted to:

| Role | Has `export:run` |
| --- | --- |
| ADMINISTRATOR | Yes (all permissions) |
| OPERATIONS | Yes |
| ASSESSMENT_TEAM | Yes |
| SCHOOL_USER | No |
| VIEWER | No |

Two additional context flags shape what an authorized user actually sees:

- **School scope** — `scopeSchoolIds` comes from `schoolScopeFor(req.principal)`.
  A school-scoped user (SCHOOL_USER) only exports rows for their assigned
  schools. Scope is applied through `buildRegistrationWhere(filter, scopeSchoolIds)`,
  so it is enforced in the database query, not just the UI.
- **PII unmask** — `canUnmaskPii` is `true` only when the principal holds
  `pii:unmask` (`PERMISSION.PII_UNMASK`). This controls Emirates ID masking (see
  below). Among default roles, only ASSESSMENT_TEAM and ADMINISTRATOR have it.

## The 14 export presets

`EXPORT_PRESETS` defines every preset key and its human label:

| Preset key | Label | What it exports |
| --- | --- | --- |
| `ALL` | All Records | Every registration in scope, ignoring the current advanced filter. `applyPreset` returns `{}` (empty filter). |
| `CURRENT_FILTER` | Current Filtered View | Registrations matching exactly the advanced filter the user currently has applied. `applyPreset` returns the base filter unchanged. This is the default when no valid preset is supplied. |
| `NOT_STARTED` | Not Started | Registrations where `dashboardStatus = NOT_STARTED`, combined with the base filter. |
| `IN_PROGRESS` | In Progress | Registrations where `dashboardStatus = IN_PROGRESS`, combined with the base filter. |
| `COMPLETED` | Completed | Registrations where `dashboardStatus = COMPLETED`, combined with the base filter. |
| `UNDER_REVIEW` | Under Review | Registrations where `dashboardStatus = UNDER_REVIEW`, combined with the base filter. |
| `REVIEW_FAILED` | Review Failed | Registrations where `dashboardStatus = REVIEW_FAILED`, combined with the base filter. |
| `UNKNOWN` | Unknown | Registrations where `dashboardStatus = UNKNOWN`, combined with the base filter. |
| `API_ERRORS` | API Errors | Registrations flagged with an API/sync error. `applyPreset` sets `apiError = '1'` on top of the base filter. |
| `SYNC_FAILURES` | Sync Failures | Same underlying filter as `API_ERRORS` (`apiError = '1'`) combined with the base filter. |
| `SCHOOL_SUMMARY` | School Summary | One aggregated row **per school** (not per registration). See "Summary presets" below. |
| `SUBJECT_SUMMARY` | Subject Summary | One aggregated row **per subject** (not per registration). |
| `RESULTS_SUMMARY` | Results Summary | Registration rows, but with a fixed results-focused column set (columns query param is ignored). |
| `ATTENTION` | Students Requiring Attention | Open items from the attention queue (`status = OPEN`), one row per attention item. |

The status presets map to normalized `DASHBOARD_STATUS` values via the internal
`STATUS_PRESETS` table. If a request passes a preset key that is not in
`EXPORT_PRESETS`, the route falls back to `CURRENT_FILTER`.

## How presets combine with the current advanced filter

Row exports are built by layering the preset **on top of** the advanced filter
the request carries. The route parses the filter from the query string with
`parseFilter(req.query)`, then `runExport` calls `applyPreset(preset, base)`:

```ts
export function applyPreset(preset, base) {
  if (preset === 'ALL') return {};                 // ignore the base filter
  if (preset === 'CURRENT_FILTER') return base;     // use it verbatim
  if (STATUS_PRESETS[preset]) return { ...base, status: STATUS_PRESETS[preset] };
  if (preset === 'API_ERRORS' || preset === 'SYNC_FAILURES') return { ...base, apiError: '1' };
  return base;
}
```

So, for example, if the user has filtered to `grade=6` in the UI and exports the
`COMPLETED` preset, the export contains grade-6 registrations that are also
COMPLETED. `ALL` deliberately discards the base filter; `CURRENT_FILTER` keeps it
untouched. The Live Monitoring export buttons always use `preset=CURRENT_FILTER`
and pass the page's live filters plus selected columns
(`src/views/monitoring.ejs`).

## Formats: CSV and XLSX

The `format` query param selects the output; anything other than `xlsx` yields
`csv`.

- **CSV** — UTF-8 text with a leading Byte Order Mark (`﻿`) prepended before
  the CSV body. The BOM makes Excel open the file with correct UTF-8 decoding, so
  Arabic student names render correctly instead of as mojibake. Content type:
  `text/csv; charset=utf-8`.
- **XLSX** — a real Excel workbook built with the `xlsx` library.
  Content type: `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`.

Both formats share the same row data and the same cell sanitization. The sheet is
named per preset family: `Registrations`, `Schools`, `Subjects`, or `Attention`.

## Columns and sort order (row exports)

For registration row exports (`ALL`, `CURRENT_FILTER`, the status presets,
`API_ERRORS`, `SYNC_FAILURES`):

- **Columns** — the `columns` query param is a comma-separated list of column
  keys. It is split, trimmed, and passed to `resolveColumns`, which keeps only
  known column keys **in the requested order** and falls back to the default
  visible columns if the list is empty or contains no valid keys. The canonical
  column catalogue lives in `src/services/columns.ts` (`REGISTRATION_COLUMNS`);
  the same list powers the Live Monitoring table and saved views, so exports stay
  consistent with what the user sees on screen.
- **Sort** — `sortBy` and `sortDir` are passed through `safeSort(sortBy, sortDir)`,
  which validates the field and direction before they reach the `orderBy` clause.

`RESULTS_SUMMARY` ignores the `columns` param and always emits this fixed set:
`StudentId, SchoolName, ExamSubject, TestCode, FastTestStatus, RawScore,
ScaledScore, Correct, Incorrect, Skipped, Attempted, TotalItems,
CompletionPercentage, TimeUsed`.

## The `MAX_ROWS` cap (5000)

Every export is capped at `MAX_ROWS = 5000` rows:

- Registration queries use `take: MAX_ROWS`.
- The attention export requests page 1 with a page size of `MAX_ROWS`.

The cap bounds memory and response time for a synchronous, in-request export.
Exports build the entire workbook in memory and stream it back on the same HTTP
request; the 5000-row ceiling keeps a single export from exhausting server memory
or blocking the request for too long. If a dataset exceeds 5000 rows, narrow it
with the advanced filter (e.g. by school, subject, or status) and export in
slices.

## Formula-injection prevention (`sanitizeCell`)

Spreadsheet applications can execute a cell whose value begins with a formula
character. To prevent CSV/Excel formula injection, every string cell is passed
through `sanitizeCell` before it is written:

```ts
export function sanitizeCell(v) {
  if (typeof v !== 'string') return v;
  if (/^[=+\-@\t\r]/.test(v)) return `'${v}`; // prefix a single quote
  return v;
}
```

If a string starts with any of `=`, `+`, `-`, `@`, tab, or carriage return, it is
neutralized by prefixing a single quote (`'`), so the spreadsheet treats it as
literal text rather than a formula. Non-string values (numbers, booleans, null)
pass through untouched. Sanitization is applied to **every** cell of **every**
export format inside `toWorkbook`, so both CSV and XLSX outputs are protected.

## What is never exported

- **Secrets** are never included. Encrypted workspace credentials
  (`restApiKeyEncrypted`, `usernameEncrypted`, `passwordEncrypted`) and similar
  fields never appear in any column definition or summary row.
- **Raw API JSON** (the full FastTest payloads stored in `rawJson` fields) is
  excluded from exports. It is only available through a separate, explicit
  admin-only endpoint — not through the export presets documented here.

## Emirates ID masking

The `EmiratesId` column runs its value through `maskEmiratesId(value, canUnmask)`
(`src/services/columns.ts`):

- If the caller has `pii:unmask`, the full Emirates ID is returned.
- Otherwise the value is masked to `***-****-*******-<last digit>`, revealing
  only the final check digit. If fewer than 4 digits are present, it renders as
  `***`.

Because `canUnmaskPii` is derived from the principal's `pii:unmask` permission and
threaded into the column getter, masking is enforced at export time exactly as it
is in the on-screen table.

## Export history (`ExportJob`)

Every export attempt is recorded as an `ExportJob` row for history and audit. The
job is created with status `PENDING` before the data is gathered, updated to
`COMPLETED` (with the final `recordCount`) on success, or `FAILED` (with a
truncated `failureReason`) on error.

`ExportJob` fields (see `prisma/schema.prisma`):

| Field | Meaning |
| --- | --- |
| `exportType` | The preset key used (e.g. `ALL`, `COMPLETED`, `SCHOOL_SUMMARY`). |
| `format` | `csv` or `xlsx`. |
| `filtersJson` | JSON snapshot of the base advanced filter for the request. |
| `recordCount` | Number of rows written (set on completion). |
| `status` | `PENDING` → `COMPLETED` or `FAILED`. |
| `startedAt` | When the job was created. |
| `completedAt` | When it finished (success or failure). |
| `failureReason` | Error message (truncated to 500 chars) when `FAILED`. |
| `createdBy` | Snapshot of the actor's email. |

In addition to the `ExportJob`, each successful export writes an `AuditLog` entry
with `action = EXPORT` and a detail string like `preset=... format=... count=...`.

### Where history is shown

- **`GET /export`** — server-rendered Reports & Export page. Renders the preset
  list and the recent export jobs.
- **`GET /api/export-jobs`** — JSON list of recent export jobs.

Both require `export:run`. Visibility is scoped by user unless the caller is an
admin: `listExportHistory(userId, isAdmin)` returns only the caller's own jobs
unless the principal holds `user:manage` (`PERMISSION.USER_MANAGE`), in which case
all jobs are returned. Results are ordered by `startedAt` descending.

## Endpoints

| Method & path | Purpose |
| --- | --- |
| `GET /export/registrations` | Primary export endpoint (server-rendered links land here). Requires `export:run`. |
| `GET /api/registrations/export` | Same handler, JSON/API entry point. Requires `export:run`. |
| `GET /api/export-jobs` | JSON export history. Requires `export:run`. |
| `GET /export` | Reports & Export page (presets + history). Requires `export:run`. |

Both export endpoints accept the same query params: `preset`, `format`,
`columns`, `sortBy`, `sortDir`, plus any advanced-filter params consumed by
`parseFilter`. The response sets `Content-Disposition: attachment` with a filename
of `<preset-lowercased>-<jobId first 8 chars>.<ext>`.

## Example URLs

Export the COMPLETED preset as XLSX with a specific, ordered column set:

```
/export/registrations?preset=COMPLETED&format=xlsx&columns=StudentId,ExamSubject,RawScore
```

Export the current filtered view as CSV (what the Live Monitoring "Export CSV"
button generates, carrying live filters + the user's selected columns):

```
/export/registrations?preset=CURRENT_FILTER&format=csv&columns=StudentId,NameEnglish,SchoolName,ExamSubject,FastTestStatus&sortBy=StudentId&sortDir=asc
```

Export a school-level summary workbook:

```
/export/registrations?preset=SCHOOL_SUMMARY&format=xlsx
```

Export the open attention queue:

```
/export/registrations?preset=ATTENTION&format=csv
```

## Summary presets vs. row exports

Four presets do not emit one row per registration. They aggregate or pull from a
different source, and their columns are **fixed** (the `columns` query param does
not apply):

- **`SCHOOL_SUMMARY`** — calls `schoolsSummary(where)` and emits one row per
  school: School ID, School, Total, per-status counts (Not Started, In Progress,
  Completed, Under Review, Review Failed, Unknown), Completion %, Avg Time (s),
  Avg Raw Score, and API Errors. Sheet name: `Schools`.
- **`SUBJECT_SUMMARY`** — calls `subjectsSummary(where)` and emits one row per
  subject: Subject, Total, Not Started, In Progress, Completed, Completion %, Avg
  Duration (s), Avg Raw Score, Avg Scaled Score, Correct, Incorrect, Skipped.
  Sheet name: `Subjects`.
- **`RESULTS_SUMMARY`** — a registration-row export, but with the fixed
  results-focused column set listed above (per-student scores and item breakdown)
  rather than user-selected columns.
- **`ATTENTION`** — pulls from the attention queue via
  `listAttention({ status: 'OPEN' }, scopeSchoolIds, 1, MAX_ROWS)` and emits one
  row per open item: Student, School, Subject, TestCode, Issue, Severity, Status,
  Last Error, Retry Count, Recommended Action. Sheet name: `Attention`.

Both `SCHOOL_SUMMARY` and `SUBJECT_SUMMARY` still honor school scope and the base
advanced filter through `buildRegistrationWhere(baseFilter, scopeSchoolIds)`, so a
summary reflects the same slice of data the user is looking at — just aggregated.
The `ATTENTION` export honors school scope but is fixed to open items regardless
of the base status filter.
