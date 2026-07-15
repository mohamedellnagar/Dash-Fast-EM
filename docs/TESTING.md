# Testing Guide

Testing guide for the **FastTest Live Monitoring & Analytics Dashboard**.

**Current status: 190 tests passing across 31 test files.**

---

## Test philosophy

- **Never hit the live FastTest API in automated tests / CI.** The FastTest client is exercised through a **mock `HttpTransport`** — tests build a scripted transport that returns canned `HttpResponse` objects in call order, so auth, status, results, retries, and error classification are all verified deterministically without network access.
- **Isolated test database.** Automated tests run against a throwaway SQLite file (`prisma/test.db`) provisioned fresh on every run, so tests never touch dev or production data.
- **No fabricated data.** Mappers preserve raw payloads and leave missing fields undefined rather than inventing values (see the results-mapper tests).
- **Live FastTest tests are opt-in only** — never part of the default run or CI.

---

## How to run

```bash
npm test
```

What happens:

1. **`pretest`** runs `bash scripts/prepare-test-db.sh`, which:
   - sets `DATABASE_URL="file:./test.db"`,
   - deletes any existing `prisma/test.db` (and journal),
   - runs `npx prisma migrate deploy`,
   - seeds the database via `prisma/seed.ts`,
   - prints `test database ready (prisma/test.db)`.
2. **`test`** runs `DATABASE_URL="file:./test.db" vitest run`.

Vitest config (`vitest.config.ts`): Node environment, includes `tests/**/*.test.ts`, **excludes `tests/live/**`**, `testTimeout` 20s / `hookTimeout` 30s, and runs in a **single fork** (`pool: 'forks'`, `singleFork: true`) so the shared SQLite file is accessed serially.

Watch mode:

```bash
npm run test:watch
```

---

## The 31 test files

Phase 1 shipped 11 files (6 unit + 5 integration); Phase 2 adds 8 more (3 unit +
5 integration), bringing the totals to **9 unit + 10 integration = 19 files, 121
tests**. Phase 3 adds 12 more (4 unit + 8 integration), bringing the totals to
**13 unit + 18 integration = 31 files, 190 tests**.

### Unit tests (`tests/unit/`)

| File | Covers |
|------|--------|
| `testcode.test.ts` | **TestCode normalization** — `normalizeTestCode` strips hyphens/spaces, trims, uppercases; handles null/undefined/empty; is idempotent. `buildTestCode` preserves the original while producing the normalized form. |
| `enums.test.ts` | **Status mapping & error classification** — `toDashboardStatus` maps all known FastTest statuses (NEW→NOT_STARTED, INPROGRESS→IN_PROGRESS, COMPLETED, INREVIEW→UNDER_REVIEW, FAILEDREVIEW→REVIEW_FAILED), is case/format insensitive, falls back to UNKNOWN. `PERMANENT_ERRORS` includes NOT_FOUND / INVALID_TESTCODE but not TIMEOUT. |
| `crypto.test.ts` | **AES-256-GCM secret encryption** — `encrypt`/`decrypt` round-trip, `v1:` prefix, random IV (different ciphertext each call), tamper detection (throws), and `maskSecret` display masking. |
| `token-cache.test.ts` | **Per-workspace token cache** — returns null when empty; serves a fresh token before the refresh margin; treats a token as expired inside the 300s margin (3600s TTL → stale after 3300s); invalidates a single workspace; isolates tokens per workspace. |
| `results-mapper.test.ts` | **Results mapper calculated fields** — `formatDuration` HH:MM:SS; computes attempted / total items / completion %; extracts scores and `passed`; splits `startTime` into date + time; does not fabricate missing fields; preserves the complete raw payload. |
| `rbac.test.ts` | **RBAC role → permission grants** — ADMINISTRATOR has every permission; VIEWER is read-only (no import/sync/integration); OPERATIONS can manual-sync + export but not manage integration; ASSESSMENT_TEAM sees results but cannot manual-sync; only ADMINISTRATOR can view raw API responses. |
| `filters.test.ts` *(Phase 2)* | **Advanced registration filters** — parses & drops empty values; coerces numeric ranges; always ANDs `deletedAt: null`; **enforces server-side school scope (non-bypassable)** and blocks all rows on an empty scope array; normalizes `testCode` search to compact uppercase; supports multi-status via CSV; builds score/duration ranges as a results-relation filter; maps `apiError` to error/manual-review sync statuses; `safeSort` allow-lists columns; serializes a filter back to a query string. |
| `columns.test.ts` *(Phase 2)* | **Column registry & PII masking** — resolves default columns when none requested; preserves requested order and ignores unknown keys; falls back to defaults when all requested keys are invalid; exposes all documented columns; **masks Emirates ID unless permitted**; renders null as `N/A` and never coerces to 0. |
| `export-sanitize.test.ts` *(Phase 2)* | **CSV/Excel formula-injection prevention & export presets** — neutralizes cells starting with formula characters, leaves safe strings/numbers untouched; `ALL` clears the filter, `CURRENT_FILTER` keeps the base filter, status presets set the dashboard status, and `API_ERRORS`/`SYNC_FAILURES` set the `apiError` flag. |
| `retry.test.ts` *(Phase 3)* | **Retry policy & backoff** — per-error-category retry decisions (which categories retry vs. give up) and full-jitter exponential backoff bounds. |
| `error-classifier.test.ts` *(Phase 3)* | **Error classification** — maps HTTP/FastTest failures to the 13 ERROR_CATEGORY values (AUTHENTICATION, TOKEN_EXPIRED, NOT_FOUND, INVALID_TEST_CODE, WORKSPACE_MISMATCH, RATE_LIMIT, TIMEOUT, NETWORK, FASTTEST_INTERNAL_ERROR, INVALID_RESPONSE, DATABASE, QUEUE, UNKNOWN) with retryability, severity and recommended action. |
| `sync-state.test.ts` *(Phase 3)* | **Sync-state machine** — the 15-state machine's allowed transitions are validated and illegal transitions rejected. |
| `rate-limiter.test.ts` *(Phase 3)* | **Per-workspace rate limiter** — token bucket (rps/rpm/min-delay/burst) admits within limits and defers/blocks when exceeded; per-endpoint concurrency; config from DB + env defaults. |

### Integration tests (`tests/integration/`)

| File | Covers |
|------|--------|
| `fasttest-client.test.ts` | **FastTest client with mock transport (no live calls)** — authenticates and caches the token (`/auth/simple`, sends `apiKey` + `tokenTTL`); sends the bearer token and returns status; refreshes + retries **once on 401**; classifies **404 → NOT_FOUND** and **timeout → TIMEOUT**; fails cleanly when the API key is missing. |
| `workspace-resolution.test.ts` | **Workspace resolution by subject (seeded aliases)** — `normalizeAlias` normalization; multiple Arabic aliases resolve to the ARABIC workspace; Math aliases resolve to MATH; unknown/empty subjects return null; resolved secrets are decrypted (never leak `v1:` ciphertext). |
| `import.test.ts` | **Student data import** — detects missing required columns (ExamSubject, TestCode); validates rows and flags errors (missing TestCode, bad StartDate) without inserting invalid rows; applies TestCode normalization; detects in-file duplicates; commits valid rows as upsert (create then update); resolves subject→workspace; **preserves original `attendanceOriginal`** on re-import. |
| `sync.test.ts` | **`syncRegistration` end-to-end (mock transport)** — persists a status snapshot and denormalizes fields; fetches results and computes attempted/total/scores when **COMPLETED**; does **not** fetch results while **IN_PROGRESS** and schedules a fast (45s) next sync; marks a **404 as MANUAL_REVIEW** (permanent error, not rescheduled). |
| `app.test.ts` | **HTTP app via supertest** — health endpoints (`/health`, `/health/database`, `/health/fasttest`); authentication (unauthenticated → redirect to `/login`, invalid creds → 401, failed attempt written to audit log, valid admin reaches the dashboard); **RBAC enforcement** (admin opens Integration Settings, viewer gets 403 on settings and exports, unauthenticated API → 401 JSON). |
| `dashboard-analytics.test.ts` *(Phase 2)* | **Analytics accuracy** — status counts and completion rate match the data; correct/incorrect/skipped and averages come from results **only**; averages return `null` (not 0) when no results match; per-school and per-subject summaries with item sums; completion-by-grade; score-distribution bucketing of denormalized raw scores; completion trends grouped by exam start date; **KPIs and the filtered table stay consistent** (filtering by school narrows both). |
| `saved-views.test.ts` *(Phase 2)* | **Saved views** — creates a view and sanitizes unknown columns; keeps views private to their owner unless shared; only allows sharing with the `savedview:share` permission; enforces a single default per user/page; duplicates and soft-deletes a view; cannot edit another user's view. |
| `export.test.ts` *(Phase 2)* | **Export service** — exports all records as CSV and records history; the `COMPLETED` preset filters to completed rows only; **neutralizes formula-injection** in exported cells; **enforces school scope** on exports; produces the school-summary preset; lists export history. |
| `attention.test.ts` *(Phase 2)* | **Attention classification & queue lifecycle** — detects each issue type (API not found, missing workspace mapping, auth failure, sync failed after max retries, no results after completion, stale in-progress, attendance/status conflict, missing student mapping) and yields no issues for a healthy registration; `refreshAttention` upserts items and **auto-resolves stale ones**; lists items respecting school scope; supports assign / status change / notes; summary counts open items by severity. |
| `rbac-scope.test.ts` *(Phase 2)* | **School-scoped access control (server-enforced)** — a school user only sees their assigned school in `/api/registrations` and **cannot bypass scope** by passing another `schoolId`; gets 403 opening another school's detail page; a viewer cannot access the attention queue or export; unauthenticated analytics API returns 401. |
| `lock.test.ts` *(Phase 3)* | **Distributed lock (mock transport, no live calls)** — acquire/renew/release, exclusive ownership, expiry + reaping, read-after-write takeover of expired locks. |
| `queue.test.ts` *(Phase 3)* | **Durable queue (mock transport, no live calls)** — enqueue with dedup, atomic single-winner claim (guarded `updateMany`), complete/fail with retry-scheduled/dead-letter/manual-review transitions, cancel, requeue dead-letter, retry-failed, stalled recovery, queue stats. |
| `circuit-breaker.test.ts` *(Phase 3)* | **Circuit breaker (mock transport, no live calls)** — CLOSED→OPEN on threshold breaches, OPEN blocks jobs, HALF_OPEN probe recovery back to CLOSED. |
| `scheduler.test.ts` *(Phase 3)* | **Scheduler (mock transport, no live calls)** — computes due jobs / nextSyncAt / priority / active window, enqueues them idempotently (dedup), and refreshes stale flags. |
| `worker-e2e.test.ts` *(Phase 3)* | **Worker end-to-end (mock client, no live calls)** — claim→run→finalize of a real job through the worker's `processOneJob` against a mock client, including per-job heartbeat and outcome persistence. |
| `token-refresh.test.ts` *(Phase 3)* | **Token refresh lifecycle (mock transport, no live calls)** — proactive refresh scheduling, single-refresher via the distributed lock, auth-failure counting. |
| `adaptive-retention.test.ts` *(Phase 3)* | **Adaptive throttle + retention (mock transport, no live calls)** — rolling latency/error-rate drives the throttle multiplier with recovery; retention cleanup deletes aged rows while preserving active jobs and unresolved alerts. |
| `phase3-rbac.test.ts` *(Phase 3)* | **Phase 3 RBAC (mock transport, no live calls)** — the 11 new permissions gate queue/sync/worker/alert endpoints per role (ADMINISTRATOR all; OPERATIONS operational incl. `workspace:pause` + `queue:manage` but NOT `sync:admin`; ASSESSMENT_TEAM read-only `sync:view`/`queue:view`/`alert:view`; SCHOOL_USER/VIEWER none). |

### Queue benchmark (`scripts/perf/queue-bench.ts`)

**Not part of the default `npm test` run.** A mock-client benchmark that verifies
**exactly-once processing** at 10 / 100 / 1000 / 10000 registrations (0
duplicate-success jobs, all jobs reach `DONE`), measuring throughput (~70 jobs/sec
on SQLite, DB-write-bound; higher on Postgres) with stable memory. It uses the mock
FastTest client — **never the live API**.

### Fixtures helper

Phase 2 DB-backed tests share `tests/helpers/fixtures.ts`: `makeSchool`,
`makeSubject`, and `makeRegistration` (which also writes a denormalized
`FastTestResult` when given a `result` + `workspaceId`), plus `clearRegistrations`
for per-test isolation. External IDs are made unique per module load so fixtures
never collide across the single shared test database.

---

## Coverage areas mapped to requirements

| Requirement area | Verified by |
|------------------|-------------|
| TestCode normalization | `unit/testcode.test.ts`, plus import + sync usage |
| Token cache (TTL, refresh margin, isolation) | `unit/token-cache.test.ts`, `integration/fasttest-client.test.ts` |
| RBAC (role → permission grants, HTTP enforcement) | `unit/rbac.test.ts`, `integration/app.test.ts` |
| Retry / error classification (401 refresh, 404 NOT_FOUND, timeout, permanent errors) | `integration/fasttest-client.test.ts`, `unit/enums.test.ts`, `integration/sync.test.ts` |
| Import validation (columns, row errors, duplicates, attendance preservation) | `integration/import.test.ts` |
| Workspace mapping (subject aliases → workspace, secret decryption) | `integration/workspace-resolution.test.ts` |
| Sync (status snapshot, denormalization, results on COMPLETED, cadence, MANUAL_REVIEW) | `integration/sync.test.ts` |
| Secret handling (AES-256-GCM, masking) | `unit/crypto.test.ts` |
| Status mapping (FastTest → dashboard) | `unit/enums.test.ts` |
| Results calculations (duration, completion %, scores) | `unit/results-mapper.test.ts` |
| Health / auth HTTP surface | `integration/app.test.ts` |
| Advanced filters + server-side school scoping | `unit/filters.test.ts`, `integration/rbac-scope.test.ts` |
| Column registry + PII (Emirates ID) masking | `unit/columns.test.ts` |
| Export presets, formats, formula-injection, scope, history | `unit/export-sanitize.test.ts`, `integration/export.test.ts` |
| Analytics accuracy + KPIs-match-table single source | `integration/dashboard-analytics.test.ts` |
| Saved views (private/shared, default, sanitize, ownership) | `integration/saved-views.test.ts` |
| Attention detection + queue lifecycle + auto-resolve | `integration/attention.test.ts` |
| Phase 2 RBAC (`attention:view`/`manage`, `export:run`, scope) | `integration/rbac-scope.test.ts` |
| Durable queue (dedup, atomic claim, retry/dead-letter, stalled recovery) | `integration/queue.test.ts`, `scripts/perf/queue-bench.ts` |
| Distributed locking | `integration/lock.test.ts` |
| Error classification + retry/backoff | `unit/error-classifier.test.ts`, `unit/retry.test.ts` |
| Sync-state machine | `unit/sync-state.test.ts` |
| Rate limiting + adaptive throttling | `unit/rate-limiter.test.ts`, `integration/adaptive-retention.test.ts` |
| Circuit breaker | `integration/circuit-breaker.test.ts` |
| Scheduler (due jobs, stale flags) | `integration/scheduler.test.ts` |
| Worker end-to-end | `integration/worker-e2e.test.ts` |
| Token refresh lifecycle | `integration/token-refresh.test.ts` |
| Retention cleanup | `integration/adaptive-retention.test.ts` |
| Phase 3 RBAC (11 new permissions) | `integration/phase3-rbac.test.ts` |

---

## Opt-in live integration tests

Live tests actually call the FastTest API and are **excluded from the default run** (`vitest.config.ts` excludes `tests/live/**`). They only run when explicitly requested:

```bash
npm run test:live
```

This sets `RUN_LIVE_FASTTEST=1` and runs `vitest run tests/live`. Requires real FastTest credentials/keys in the environment. **Do not run these in CI.**

---

## How to add a test

1. Create `tests/unit/<name>.test.ts` or `tests/integration/<name>.test.ts` (must match `tests/**/*.test.ts`).
2. Import from Vitest (`describe`, `it`, `expect`, hooks) — `globals` is enabled so these are available.
3. For anything touching the FastTest API, **use a scripted mock transport** (see the `scripted(responses)` helper pattern in `fasttest-client.test.ts` / `sync.test.ts`) — never call the live API.
4. For DB-backed tests, use `prisma` from `src/db/prisma` against `prisma/test.db`, and keep tests **idempotent** (clean up / upsert your own fixtures) since the suite runs in a single fork against a shared database.
5. Run `npm test` — `pretest` re-provisions the test DB automatically.
6. Put live-only tests under `tests/live/` so they stay opt-in.
