# Phase 2 Implementation

Analytics & operational dashboard layer, built on the Phase 1 architecture
(Express + Prisma + EJS + JSON API). No architecture was replaced. All
dashboard data comes from the internal database; the frontend never calls
FastTest and never computes large aggregations in the browser.

## What was added

### Database (5 new models + denormalization)
- `SavedView`, `UserTablePreference`, `ExportJob`, `AttentionItem`, `AttentionNote`
- `FastTestResult` gained denormalized dimensions (`schoolId`, `subjectId`,
  `grade`, `examSubject`) and a denormalized **primary score summary**
  (`rawScore`, `scaledScore`, `sumScore`, `cutScore`, `correctCount`,
  `incorrectCount`, `skippedCount`) so per-school/subject analytics run as a
  single indexed `groupBy` instead of joining through scores on every request.
- Migration: `20260713070938_phase2_analytics`.

### Services
| Service | Responsibility |
|---|---|
| `services/filters.ts` | 25+ field advanced filter: Zod validation, `buildRegistrationWhere` with **server-enforced school scoping**, score/duration range via results relation, allow-listed sorting, URL (de)serialization |
| `services/dashboard.service.ts` | All backend aggregations: `overview`, `kpiBlock`, `statusDistribution`, `schoolsSummary`, `subjectsSummary`, `completionByGrade`, `durationsBySubject`, `scoresBySubject/School`, `scoreDistribution`, `completionTrends`, `correctIncorrectSkipped`, `apiHealth`, `listRegistrationsWhere` |
| `services/columns.ts` | Canonical registration column registry (getters shared by table + export), `maskEmiratesId`, null→`N/A` display |
| `services/saved-views.service.ts` | Saved view CRUD, default/shared rules, column sanitization, table preferences |
| `services/export.service.ts` | 14 presets, CSV/XLSX, **CSV formula-injection neutralization**, scope/column/sort aware, export job history |
| `services/attention.service.ts` | Detection rules (10 issue types), idempotent `refreshAttention` with SYSTEM auto-resolve, list/assign/status/notes/summary |

### Routes
- `dashboard-api.routes.ts` → `/api/dashboard/overview|status-distribution|schools|schools/:id|subjects|subjects/:subject|completion-trends|scores|durations|api-health`
- `saved-views.routes.ts` → `/api/saved-views` (+ `/columns`, `/prefs/table`)
- `attention.routes.ts` → `/attention` page + `/api/attention*`
- `export.routes.ts` → `/export` page, `/export/registrations`, `/api/registrations/export`, `/api/export-jobs`
- `dashboard.routes.ts` → new pages `/schools`, `/schools/:id`, `/subjects`, `/subjects/:subject`; `/monitoring` upgraded with advanced filters + column selection + saved views
- `api.routes.ts` → `/api/registrations` upgraded to advanced filters

### Views (EJS, existing design system)
`schools.ejs`, `school-detail.ejs`, `subjects.ejs`, `subject-detail.ejs`,
`attention.ejs`, `export.ejs`, upgraded `monitoring.ejs`; reusable partials
`filters.ejs`, `hbars.ejs`, `statusbar.ejs`. RTL-ready styles, empty/loading/
skeleton states, consistent status indicators.

## Data-accuracy rules enforced
- Completion Rate = Completed / Total valid registrations × 100.
- Attempted = Correct + Incorrect; Total Items = Correct + Incorrect + Skipped.
- Averages come from `FastTestResult` rows only; when none match, the value is
  **null → rendered `N/A`** (never coerced to 0).
- `Passed` is not inferred when the API returns null; DateCompleted/TimeCompleted
  are never fabricated.
- KPIs and the table share one `where` clause, so they always agree.

## Security
- RBAC enforced on every endpoint (page + JSON). New permissions:
  `attention:view`, `attention:manage`, `savedview:share`, `pii:unmask`.
- School scope is injected server-side from the principal and AND-combined into
  every query — a school user passing another `schoolId` gets an empty result,
  not another school's data.
- Emirates ID masked unless the role has `pii:unmask`.
- CSV/Excel formula injection neutralized on export.
- Exports never include secrets; raw API JSON stays admin-only.

## Verification
- `npm test` → **121 passing** across 19 files (mock FastTest transport only).
- Live app: import → saved view → column selection → preset export → attention
  refresh all verified end-to-end with zero server errors; every Phase 2 page
  returns HTTP 200.
