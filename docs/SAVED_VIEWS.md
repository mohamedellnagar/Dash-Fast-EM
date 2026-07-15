# Saved Views & Table Preferences

Saved views let a user capture a page's filters, sort, columns, and page size as a
reusable, named configuration. Table preferences are a separate, lighter-weight
mechanism that remembers a user's default columns and page size per page. This
guide documents both as implemented in `src/services/saved-views.service.ts`,
`src/routes/saved-views.routes.ts`, `src/services/columns.ts`, and the
`SavedView` / `UserTablePreference` models in `prisma/schema.prisma`.

The saved-views router is mounted at **`/api/saved-views`** and requires
authentication (`requireAuth`) — any authenticated user manages their own views.

## What a saved view stores

A saved view (`SavedView` model, validated by `savedViewSchema`) holds:

| Field | Type | Notes |
| --- | --- | --- |
| `name` | string, 1–120 chars | Required, trimmed. |
| `description` | string, up to 500 chars | Optional, trimmed. |
| `pageType` | enum | One of `registrations`, `schools`, `subjects`, `attention`. |
| `filters` | object | Arbitrary filter key/value map; stored as `filtersJson`. |
| `sortBy` | string, up to 60 chars | Optional. |
| `sortDir` | `asc` \| `desc` | Optional. |
| `columns` | string[] | Visible columns, **in order**; stored as `columnsJson`. Only known column keys are persisted (see sanitization). |
| `pageSize` | int 1–200, default 25 | |
| `isDefault` | boolean, default false | At most one default per user per page. |
| `isShared` | boolean, default false | Only honored for users with `savedview:share`. |

Two more fields are managed automatically: `userId` (the owner/creator) and
`deletedAt` (soft-delete marker).

## Page types

`PAGE_TYPES = ['registrations', 'schools', 'subjects', 'attention']`. A saved view
belongs to exactly one page type, and listing/default lookups are always scoped to
a page type so a "registrations" view never leaks onto the "schools" page.

## Private by default vs. shared

- A newly created view is **private to its owner** by default (`isShared: false`).
  It only appears in that user's own view list.
- A **shared** view (`isShared: true`) appears for **all** users on that page. To
  actually create a shared view, the caller must hold the `savedview:share`
  permission (`PERMISSION.SAVED_VIEW_SHARE`), which by default is granted only to
  ADMINISTRATOR (it is part of `Object.values(PERMISSION)`).

The route computes `canShare = principal.permissions.has(PERMISSION.SAVED_VIEW_SHARE)`
and passes it to the service. In `createView`/`updateView` the effective shared
flag is `input.isShared && canShare` — so if a non-admin submits `isShared: true`,
it is silently forced back to `false`.

Visibility follows from this in `listViews`:

```ts
where: { pageType, deletedAt: null, OR: [{ userId }, { isShared: true }] }
```

A user sees their own views plus every shared view for that page. `getView`
enforces the same rule: a view is returned only if the caller owns it or it is
shared.

## Single-default-per-user-per-page rule

Each user may have at most one default view per page type. Setting a view as
default clears the flag on the user's other views for that page, inside a
transaction:

- **On create** — if `isDefault` is true, `updateMany` clears `isDefault` on the
  user's other views for that page before inserting.
- **On update** — same clearing, excluding the view being updated (`NOT: { id }`).
- **On `setDefault`** — clears all of the user's defaults for that page, then sets
  the target.

### Default resolution

`getDefaultView(userId, pageType)` prefers the user's own default; if none exists,
it falls back to a **shared** default for that page (most recently updated). So an
admin can publish a shared default that applies to users who have not chosen their
own.

## Column sanitization

Only known column keys are ever persisted. `sanitizeColumns` filters the incoming
list against `COLUMN_KEYS` (derived from `REGISTRATION_COLUMNS` in `columns.ts`):

```ts
function sanitizeColumns(cols) {
  return cols.filter((c) => COLUMN_KEYS.includes(c));
}
```

This defends against arbitrary or malformed column input in both saved views
(`createView`/`updateView`) and table preferences (`saveTablePreference`). Order is
preserved for the keys that survive filtering.

## CRUD API

All routes below are under `/api/saved-views` and require authentication.

### List views for a page

```
GET /api/saved-views?pageType=registrations
```

Returns the caller's own views plus shared views for the page, ordered with
defaults first then by name:

```json
{
  "views": [
    {
      "id": "…",
      "name": "Completed - Grade 6",
      "description": "…",
      "pageType": "registrations",
      "filters": { "grade": "6", "status": "COMPLETED" },
      "sortBy": "StudentId",
      "sortDir": "asc",
      "columns": ["StudentId", "NameEnglish", "SchoolName", "RawScore"],
      "pageSize": 25,
      "isDefault": true,
      "isShared": false
    }
  ]
}
```

### Get a single view

```
GET /api/saved-views/:id
```

Returns the hydrated view, or `404 { "error": "Not found" }` if it does not exist
or the caller may not see it (private and not owned).

### Create a view

```
POST /api/saved-views
Content-Type: application/json

{
  "name": "Completed - Grade 6",
  "description": "Only completed grade-6 registrations",
  "pageType": "registrations",
  "filters": { "grade": "6", "status": "COMPLETED" },
  "sortBy": "StudentId",
  "sortDir": "asc",
  "columns": ["StudentId", "NameEnglish", "SchoolName", "RawScore"],
  "pageSize": 25,
  "isDefault": true,
  "isShared": false
}
```

`201 Created` returns the hydrated view. Invalid input yields
`400 { "error": "Invalid input", "details": … }` (Zod flattened errors).

### Update a view

```
PUT /api/saved-views/:id
Content-Type: application/json

{ "name": "Completed - Grade 6 (v2)", "isDefault": true }
```

The body is validated with `savedViewSchema.partial()`, so any subset of fields is
accepted. **Only the owner may edit** — a non-owner (or missing view) yields
`404 { "error": "Not found or not owner" }`.

### Duplicate a view

```
POST /api/saved-views/:id/duplicate
```

Copies a view the caller can see (own or shared) into a new **private** view owned
by the caller, named `"<original> (copy)"`, with `isDefault` and `isShared` reset
to `false`. Returns `201` with the new view, or `404` if the source is not visible.

### Set default

```
POST /api/saved-views/:id/default
```

Marks the view as the caller's default for its page (clearing any previous
default). Owner-only; returns `404 { "error": "Not found or not owner" }` otherwise.

### Delete (soft delete)

```
DELETE /api/saved-views/:id
```

Soft-deletes the view by setting `deletedAt`; the row is retained but excluded from
all queries (which filter `deletedAt: null`). Owner-only; returns
`{ "ok": true }` on success or `404` otherwise.

## Per-user table preferences

Table preferences are **independent of saved views**. They store a user's default
column configuration and page size per page in the `UserTablePreference` model,
keyed uniquely by `(userId, pageType)`. Unlike saved views, there is no name,
filters, sort, sharing, or default flag — just columns and page size.

### Get preferences

There is a service helper `getTablePreference(userId, pageType)` used server-side;
it returns `{ columns, pageSize }` or `null` when the user has none for that page.

### Save preferences

```
PUT /api/saved-views/prefs/table
Content-Type: application/json

{ "pageType": "registrations", "columns": ["StudentId", "SchoolName", "RawScore"], "pageSize": 50 }
```

Upserts the `(userId, pageType)` preference. Columns are run through
`sanitizeColumns`, so only known keys are stored. `pageSize` is validated to 1–200
(default 25). Returns `{ "ok": true }`.

## Column catalogue endpoint

The column-selector UI fetches the canonical column list from:

```
GET /api/saved-views/columns
```

```json
{
  "columns": [ { "key": "StudentId", "label": "Student ID", "defaultVisible": true }, … ],
  "defaults": ["StudentId", "NameArabic", "NameEnglish", "SchoolName", … ]
}
```

`columns` is every entry from `REGISTRATION_COLUMNS`; `defaults` is `DEFAULT_COLUMNS`
(the keys whose `defaultVisible` is true).

## Column selection UX in Live Monitoring

`src/views/monitoring.ejs` implements the column selector for the registrations
page. The behavior:

- **Columns ▾ button** toggles a panel listing all columns. Currently-selected
  columns appear first, in their current order; unselected columns follow.
- **Show / hide** — each column has a checkbox. Checking adds the key to the
  `selected` array; unchecking removes it.
- **Reorder** — selected columns each have ▲ (up) and ▼ (down) links that swap the
  column with its neighbor in the `selected` array.
- **Apply** — reloads the page with the current `selected` list joined into the
  `columns` query param, in order (`p.set('columns', selected.join(','))`).
- **Defaults** — resets `selected` back to `DEFAULTS` (the default-visible keys)
  and reloads.

The selected column list is carried on the URL as `columns=key1,key2,…`. The same
`columns` param is also appended to the Export CSV/XLSX links, so the exported
file matches the on-screen columns and order. Sorting links likewise preserve the
selected columns while updating `sortBy`/`sortDir`.

Saved views tie into the same UI: "Save current as view…" POSTs the current
filters, `selected` columns, sort, and page size to `POST /api/saved-views`;
"Apply" rebuilds the URL from a stored view's `filters`, `columns`, `sortBy`,
`sortDir`, and `pageSize`; "Set default" and "Delete" call the corresponding
endpoints.

## Canonical column list (`columns.ts`)

The full `REGISTRATION_COLUMNS` catalogue. "Default" marks columns whose
`defaultVisible` is true (shown when no explicit selection exists). Columns marked
numeric are flagged `numeric: true`.

| Key | Label | Default-visible | Numeric | Notes |
| --- | --- | --- | --- | --- |
| `StudentId` | Student ID | Yes | — | Source student external id. |
| `NameArabic` | Name (Arabic) | Yes | — | |
| `NameEnglish` | Name (English) | Yes | — | |
| `EmiratesId` | Emirates ID | No | — | Masked unless `pii:unmask`. |
| `SchoolId` | School ID | No | — | |
| `SchoolName` | School | Yes | — | |
| `Grade` | Grade | Yes | — | |
| `ClassCode` | Class | Yes | — | |
| `ExamSubject` | Subject | Yes | — | Raw source ExamSubject. |
| `ExamName` | Exam Name | No | — | |
| `TestCode` | Test Code | Yes | — | Original test code. |
| `AttendanceOriginal` | Attendance | No | — | Preserved source value. |
| `FastTestStatus` | Status | Yes | — | Normalized dashboard status. |
| `RegistrationDate` | Registration Date | No | — | |
| `ActualStartTime` | Actual Start | Yes | — | |
| `TimeUsed` | Time Used (s) | Yes | Yes | Seconds used. |
| `RawScore` | Raw Score | Yes | Yes | From latest result. |
| `ScaledScore` | Scaled Score | No | Yes | From latest result. |
| `Correct` | Correct | No | Yes | From latest result. |
| `Incorrect` | Incorrect | No | Yes | From latest result. |
| `Skipped` | Skipped | No | Yes | From latest result. |
| `Attempted` | Attempted | No | Yes | From latest result. |
| `TotalItems` | Total Items | No | Yes | From latest result. |
| `CompletionPercentage` | Completion % | No | Yes | From latest result. |
| `SyncStatus` | Sync | Yes | — | PENDING/OK/ERROR/MANUAL_REVIEW. |
| `LastSyncAt` | Last Sync | Yes | — | ISO timestamp. |
| `ApiError` | API Error | No | — | Latest sync error, if any. |

Each column exposes a getter that returns the **raw** value, or `null` when the
value is genuinely unavailable (the UI renders `null` as `N/A` and exports render
it as empty). This one catalogue is shared by the Live Monitoring table, saved
views (column selection and order), table preferences, and exports, keeping all
four consistent.
