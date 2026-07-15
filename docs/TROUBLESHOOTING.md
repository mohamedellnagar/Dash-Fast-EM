# Troubleshooting Guide
## FastTest Live Monitoring & Analytics Dashboard

Symptom → Cause → Fix. All commands and file references are relative to the project root. For operational procedures (health checks, MANUAL_REVIEW triage, secret rotation) see `OPERATIONS_RUNBOOK.md`.

---

## 1. Quick Reference Table

| Symptom | Likely cause | Fix |
|---|---|---|
| "Invalid credentials" on login | Wrong password, or email not found | Re-check credentials; reset the bootstrap admin via `npm run db:seed` |
| Login works then immediately blocked | User is inactive (`isActive=false`) | Reactivate the user (admin/DB); `db:seed` reactivates the bootstrap admin |
| `429 Too Many Requests` on login | > 20 login attempts in 15 min from one IP | Wait 15 min; the limiter window resets (`src/routes/auth.routes.ts`) |
| Import fails: "Missing required columns" | `StudentId`/`ExamSubject`/`TestCode` absent | Fix headers (case/space-insensitive) and re-upload |
| Import row error: TestCode invalid | TestCode < 3 chars after normalization | Correct source TestCode |
| Commit summary lists `unresolvedSubjects` / "workspace unresolved" | Subject alias not mapped to a workspace | Add mapping in Integration Settings (§3) |
| Registration stuck `PENDING`, never syncs | Worker not running, or workspace not syncable | Start worker; enable workspace + add API key (§6) |
| `MANUAL_REVIEW` with `WORKSPACE_MISMATCH` | No active workspace resolves the subject | Add/fix alias mapping; activate workspace |
| `MANUAL_REVIEW` with `NOT_FOUND` | TestCode not in that workspace / wrong subject mapping | Verify TestCode + correct subject→workspace mapping |
| Sync errors `UNAUTHORIZED`/`TOKEN_EXPIRED` | Bad/expired REST API key | Update key; run connection test (§5) |
| Sync errors `RATE_LIMITED` (429) | Too many calls to FastTest | Lower concurrency / rate limit (§5) |
| Sync errors `TIMEOUT`/`CONNECTION_FAILURE` | Network / wrong base URL | Check network + `baseUrl`; raise timeout (§5) |
| Dashboard shows no data | No import yet, or school-scoped user with no scope | Import data; assign school scopes (§7) |
| Arabic names show as mojibake in CSV | File not opened as UTF-8 | Open as UTF-8; app already adds BOM (§10) |
| `prisma migrate` errors | Drift / provider mismatch / locked DB | See §9 |
| Cannot decrypt secrets | `ENCRYPTION_KEY` changed | Re-enter workspace keys (§8) |
| `EADDRINUSE` on start | Port already in use | Free the port or change `PORT` (§11) |

---

## 2. Login Issues

Auth logic: `src/services/auth.service.ts`, `src/routes/auth.routes.ts`.

- **Wrong password / unknown email** → `authenticate` returns `INVALID_CREDENTIALS`; the page shows "Invalid credentials" and a `LOGIN_FAILED` audit entry is written. A dummy bcrypt compare runs on unknown emails to avoid user enumeration — so unknown-email and wrong-password look identical by design.
- **Inactive user** → `isActive=false` returns `INACTIVE`; the user cannot sign in even with the right password. Reactivate the user. For the bootstrap admin, `npm run db:seed` sets `isActive=true`.
- **Rate-limited** → after **20 attempts / 15 minutes** per IP, `POST /login` returns HTTP 429 (`loginLimiter`). Wait for the window to reset. (Global limit is 300 req/min per IP.)
- **Stale/disabled session** → if a logged-in user is later deactivated, `attachPrincipal` destroys the session on the next request and redirects to `/login`.

**Reset the bootstrap admin password:** set `BOOTSTRAP_ADMIN_PASSWORD` in `.env`, then:
```bash
npm run db:seed
```
(Seed only creates the admin if missing; it reactivates but does not re-hash an existing user's password unless the user is newly created. To force a password change on an existing admin, update the user's `passwordHash` directly or recreate the user.)

---

## 3. "Workspace Unresolved" on Import

**Cause:** the row's `ExamSubject` has no matching `WorkspaceSubjectMapping` (by normalized alias) and no `FastTestWorkspace` whose `subjectCode` matches. Resolution order is: exact alias mapping → fallback match on workspace `subjectCode` (`src/services/workspace.service.ts` → `resolveWorkspaceBySubject`).

**Effect:** the row still imports (registration created), but `workspaceId` is null and it will not sync. The commit summary's `unresolvedSubjects` lists the offending `ExamSubject` values.

**Fix:** in Integration Settings (`/admin/integration`, permission `integration:manage`), add a subject-alias mapping pointing that alias at the correct subject's workspace (`POST /admin/integration/mappings`). Aliases are normalized (trim → collapse whitespace → uppercase), so "Arabic Reading", "arabic reading", and "ARABIC READING" all match. Then trigger a manual sync on affected registrations.

Seeded default aliases (from `prisma/seed.ts`): Arabic → `Arabic, Arabic Reading, Arabic Writing, Arabic Language`; English → `English, English Language`; Math → `Math, Maths, Mathematics`; Science → `Science`.

---

## 4. Sync Errors by Type

Error taxonomy: `src/lib/enums.ts` (`SYNC_ERROR`); classification: `src/services/fasttest/client.ts` (`classifyError`). Each `SyncAttempt` records an `errorType`; the registration's `syncError` is `ERRORTYPE: message`.

| `errorType` | HTTP / condition | Meaning | Retried? |
|---|---|---|---|
| `UNAUTHORIZED` | 401 / 403 | Bad or missing API key/token | Yes (transient) |
| `TOKEN_EXPIRED` | (token refresh path) | Cached token expired | Auto refresh + 1 retry |
| `AUTH_FAILED` | auth 200 w/o token, or no key | Authentication rejected | Yes |
| `NOT_FOUND` | 404 | TestCode not in this workspace | **No — permanent → MANUAL_REVIEW** |
| `RATE_LIMITED` | 429 | FastTest throttling | Yes |
| `SERVER_ERROR` | ≥ 500 | FastTest server error | Yes |
| `TIMEOUT` | request abort | Call exceeded timeout | Yes |
| `CONNECTION_FAILURE` | network error | Could not reach host | Yes |
| `INVALID_TESTCODE` | empty/malformed code | TestCode invalid | **No — permanent → MANUAL_REVIEW** |
| `WORKSPACE_MISMATCH` | no workspace resolves subject | Unmapped subject | **No — permanent → MANUAL_REVIEW** |
| `INVALID_RESPONSE` | unparseable body | Unexpected payload | Yes |

Retry backoff: 0s → 30s → 120s, then `MANUAL_REVIEW` after retry count exceeds 3 (`src/services/sync/policy.ts`).

**Fixes by category:**
- **`UNAUTHORIZED` / `TOKEN_EXPIRED` / `AUTH_FAILED`** → the REST API key is wrong, missing, or revoked. In Integration Settings, re-enter the key and run the **connection test** (`POST /admin/integration/workspaces/:id/test`). Success returns `{ ok: true, ttl }`; failure returns the error type.
- **`NOT_FOUND`** → the normalized TestCode is not registered in that workspace, or the subject alias points at the wrong workspace. Verify the TestCode exists in the intended FastTest workspace and that the alias mapping targets the correct subject.
- **`RATE_LIMITED`** → lower `FASTTEST_RATE_LIMIT_PER_MINUTE` and/or `SYNC_WORKER_CONCURRENCY`, then restart the worker (§5).
- **`TIMEOUT` / `CONNECTION_FAILURE`** → check network egress and the workspace `baseUrl` (default `https://uae.fasttestweb.com/FastTest/api`). Increase `FASTTEST_REQUEST_TIMEOUT_MS` if the endpoint is legitimately slow.

---

## 5. Tuning Sync (rate limit, concurrency, timeout)

Set in `.env`, then **restart the worker** (env is read at process start):

```env
FASTTEST_RATE_LIMIT_PER_MINUTE=120   # lower to reduce 429s
SYNC_WORKER_CONCURRENCY=4            # parallel in-flight syncs
SYNC_TICK_INTERVAL_MS=15000         # worker tick cadence
SYNC_MAX_BATCH=50                   # registrations per tick
FASTTEST_REQUEST_TIMEOUT_MS=15000   # per-call timeout
SYNC_MAX_RETRIES=3                  # then MANUAL_REVIEW
```
```bash
npm run worker         # dev
npm run worker:prod    # prod
```

Connection test (per workspace): `POST /admin/integration/workspaces/:id/test`. It authenticates but never returns the token — success = key/URL/credentials are valid.

---

## 6. Worker Not Syncing

The worker (`src/workers/sync.worker.ts`) selects registrations where `syncStatus ∈ {PENDING, OK, ERROR}`, `deletedAt` is null, the workspace is `syncEnabled=true` AND `isActive=true`, and `nextSyncAt` is null or due. If nothing syncs, check in order:

1. **`SYNC_ENABLED=false`** → the worker idles ("SYNC_ENABLED is false; worker will idle"). Set `SYNC_ENABLED=true` and restart.
2. **Workspace `syncEnabled=false`** → a workspace seeded **without an API key** is created with `syncEnabled=false` (`prisma/seed.ts`). Add the key in Integration Settings and enable sync.
3. **Workspace `isActive=false`** → activate it.
4. **`nextSyncAt` in the future** → the registration was just synced and is backing off per the poll policy (e.g. `COMPLETED` backs off ~24h). This is expected; use manual sync to force it.
5. **No workspace bound / unresolved subject** → `WORKSPACE_MISMATCH` (§3).
6. **Worker process not running** → start it. Confirm via `GET /health/queue` (`syncEnabled`) and worker logs.

---

## 7. No Data on Dashboard

- **No import yet** → import registrations via the Import Center; committed rows immediately appear in Live Monitoring and KPIs.
- **School-scoped user with no/limited scope** → a `SCHOOL_USER` only sees registrations for their assigned `UserSchoolScope` schools. With **no** scopes assigned, they see nothing (`schoolScopeFor` returns a sentinel matching no school). Assign the correct schools, or verify the user's role. Raw FastTest payloads on Student Details additionally require the `raw:view` permission (Administrator only by default).
- **Data imported but statuses all `UNKNOWN`/`NOT_STARTED`** → the worker has not synced yet, or workspaces lack keys (§6).

---

## 8. `ENCRYPTION_KEY` Changed → Cannot Decrypt Secrets

FastTest workspace secrets are AES-256-GCM encrypted at rest with `ENCRYPTION_KEY` (`src/lib/crypto.ts`, ciphertext format `v1:<iv>:<tag>:<cipher>`). If the key changes, existing ciphertext **fails to decrypt** (auth-tag mismatch) — connection tests and sync auth will fail.

**Fix:**
1. If possible, restore the previous `ENCRYPTION_KEY` value.
2. Otherwise, with the new key in place, **re-enter each workspace's REST API key (and username/password)** in Integration Settings so they are re-encrypted with the new key.

Generate a valid key (64-hex or base64-32-byte; a passphrase is SHA-256'd to 32 bytes):
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

## 9. Prisma Migration & Provider Issues

Migrations live in `prisma/migrations/` (initial: `20260713053345_init`).

**Migration errors on deploy:**
```bash
npm run prisma:deploy      # prisma migrate deploy — apply pending migrations (prod)
npm run prisma:migrate     # prisma migrate dev — create+apply (dev)
npm run prisma:generate    # regenerate client after schema changes
```
- **"drift detected" / schema out of sync (dev only, DESTRUCTIVE):** `npm run db:reset` re-migrates and re-seeds.
- **Client/schema mismatch (e.g. "Unknown field"):** run `npm run prisma:generate` and rebuild.
- **Test DB:** tests use a throwaway `prisma/test.db` provisioned by `scripts/prepare-test-db.sh` (`pretest` hook); it never touches dev data.

**SQLite ↔ PostgreSQL provider mismatch:** `prisma/schema.prisma` `datasource.provider` must match the `DATABASE_URL` scheme:
- SQLite (dev/test): `provider = "sqlite"`, `DATABASE_URL="file:./dev.db"`.
- PostgreSQL (prod): set `provider = "postgresql"` and `DATABASE_URL="postgresql://user:pass@host:5432/db?schema=public"`.

A `file:` URL with a `postgresql` provider (or vice versa) fails at connect time. The schema is intentionally provider-agnostic (no native DB enums, raw payloads as TEXT, Float numerics) — only the datasource block changes between environments. After switching provider, run `npm run prisma:deploy && npm run db:seed`.

---

## 10. Arabic Text Mojibake in CSV

Exports (`src/routes/export.routes.ts`) and the import error report (`src/routes/import.routes.ts`) are already written with a **UTF-8 BOM** (`﻿`) and `charset=utf-8`, so Excel renders `NameArabic` correctly.

If Arabic still appears garbled:
- Ensure you open the file **as UTF-8** (Excel: Data → From Text/CSV → File Origin = UTF-8), not a legacy Windows/Arabic code page.
- Confirm the **source import file** was UTF-8; a mis-encoded input produces mojibake on the way in, before any BOM helps on the way out.
- Prefer the **XLSX** export (`?format=xlsx`) which avoids CSV encoding ambiguity entirely.

---

## 11. Port Already in Use (`EADDRINUSE`)

The web server binds `PORT` (default 3000). If it is taken:
```bash
lsof -i :3000                 # find the process holding the port
kill <pid>                    # stop it, or:
PORT=3001 npm start           # run on a different port
```
Set `PORT` in `.env` for a permanent change. Note the web server and sync worker are separate processes; only the web server binds a port.

---

## 12. Diagnostic Endpoints & Logs

- Health: `GET /health`, `/health/database`, `/health/queue`, `/health/fasttest` (unauthenticated). See `OPERATIONS_RUNBOOK.md` §5.
- API call history: `/admin/api-monitoring` (`apimonitoring:view`) — endpoint, HTTP status, response time, FastTest error code/message.
- Audit trail: `/admin/audit` (`audit:view`).
- Logs: structured JSON (pino) with a per-request `x-correlation-id`; the same correlation id ties an inbound request to its FastTest `ApiRequestLog` entries and `SyncAttempt` rows.
