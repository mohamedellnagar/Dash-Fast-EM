# Security

Security model for the **FastTest Live Monitoring & Analytics Dashboard**. This
document reflects the actual implementation; file references are given for each
control.

---

## Password hashing (bcrypt)

`src/services/auth.service.ts`

- Passwords are hashed with **bcrypt** (`bcryptjs`) at **cost factor 12**
  (`BCRYPT_ROUNDS = 12`).
- Verification uses `bcrypt.compare`.
- Login is written to reduce **user enumeration / timing signal**: if no user
  matches, a dummy `bcrypt.compare` is still performed against a fixed hash before
  returning `INVALID_CREDENTIALS`. Inactive users are rejected with `INACTIVE`
  only after a valid password check.

---

## Secret encryption at rest (AES-256-GCM)

`src/lib/crypto.ts`

FastTest workspace secrets — **REST API key, username, password** — are stored in
the database **AES-256-GCM** encrypted (authenticated encryption).

- **Algorithm:** `aes-256-gcm`, random **12-byte IV** per encryption.
- **Ciphertext format:** `v1:<iv_b64>:<authTag_b64>:<cipher_b64>` (colon-joined,
  base64 parts, version prefix `v1`). Decryption rejects any payload that isn't
  exactly 4 parts with the `v1` prefix, and verifies the GCM auth tag.
- **Key source:** `ENCRYPTION_KEY`. Accepted forms: 64-char hex (32 bytes),
  base64 decoding to 32 bytes, or any other string hashed with SHA-256 to 32
  bytes.
- Helpers `encryptOrNull` / `decryptOrNull` pass `null` through unchanged.
- Secrets are decrypted **only in the backend**, on demand, when resolving a
  workspace for an API call (`decryptWorkspace` in `workspace.service.ts`).

### Secret masking

`maskSecret` (`src/lib/crypto.ts`) renders a secret for display as
`WSzq********NU8w` — first 4 + `********` + last 4 characters; secrets of length
≤ 8 render as `********`. The admin workspace DTO (`listWorkspacesMasked`) returns
`restApiKeyMasked` and a boolean `hasApiKey` — **never the raw secret**.

---

## Backend-only FastTest calls

All FastTest REST calls originate from the backend (`src/services/fasttest/*`).
API keys and tokens never reach the browser. Tokens are cached **in memory only**
per workspace (`token-cache.ts`) and are never persisted or serialized to clients.

---

## Session cookies

`src/app.ts` (`express-session`, cookie name `ftsid`)

| Attribute | Value | Source |
|---|---|---|
| `httpOnly` | `true` | fixed |
| `sameSite` | `lax` | fixed |
| `secure` | `env.sessionSecureCookie` | `SESSION_SECURE_COOKIE` (default `false`) |
| `maxAge` | `env.sessionMaxAgeMs` | `SESSION_MAX_AGE_MS` (default `3600000` = 1h) |
| `rolling` | `true` | idle lifetime resets on activity |

Also: `resave: false`, `saveUninitialized: false`. The cookie is signed with
`SESSION_SECRET` (also used by `cookie-parser`). `attachPrincipal` middleware
loads the principal from `req.session.userId`; a stale/disabled user causes the
session to be destroyed (`src/middleware/auth.ts`).

---

## HTTP hardening

`src/app.ts`

- **Helmet** with a **Content-Security-Policy**:
  - `default-src 'self'`
  - `script-src 'self' 'unsafe-inline'` (inline chart bootstrap)
  - `style-src 'self' 'unsafe-inline'`
  - `img-src 'self' data:`
- `compression()` enabled; JSON/urlencoded bodies capped at **2 MB**.
- `trust proxy: 1` (correct client IP behind one proxy).
- Per-request **correlation id** header (`x-correlation-id`) for tracing.

### Rate limiting

| Limiter | Scope | Window | Max | Source |
|---|---|---|---|---|
| Global | per IP, all routes | 60 s | 300 | `src/app.ts` |
| Login | `POST /login` | 15 min | 20 | `src/routes/auth.routes.ts` |

Both use `standardHeaders: true`, `legacyHeaders: false`.

---

## RBAC (role-based access control)

`src/services/rbac.service.ts`, `src/lib/enums.ts`, `src/middleware/auth.ts`

Permissions are checked per-route via `requirePermission(permission)`, which
returns `401` (unauthenticated) or `403` (missing permission) — JSON for `/api`
and `Accept: application/json`, otherwise a redirect/rendered error page. A
principal's permission set is loaded from the DB (roles → role permissions) by
`loadPrincipal`.

### Roles → permissions matrix (`ROLE_PERMISSIONS`)

Permission keys: `dashboard:view`, `monitoring:view`, `student:view`,
`results:view`, `raw:view`, `import:run`, `export:run`, `sync:manual`,
`integration:manage`, `apimonitoring:view`, `audit:view`, `user:manage`,
`loadtest:run`, `sync:view`, `sync:bulk`, `sync:cancel`, `sync:retry`,
`sync:admin`, `queue:view`, `queue:manage`, `worker:view`, `workspace:pause`,
`alert:view`, `alert:manage`.

| Permission | ADMINISTRATOR | OPERATIONS | ASSESSMENT_TEAM | SCHOOL_USER | VIEWER |
|---|:---:|:---:|:---:|:---:|:---:|
| `dashboard:view` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `monitoring:view` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `student:view` | ✅ | ✅ | ✅ | ✅ | ❌ |
| `results:view` | ✅ | ✅ | ✅ | ❌ | ❌ |
| `raw:view` | ✅ | ❌ | ❌ | ❌ | ❌ |
| `import:run` | ✅ | ❌ | ❌ | ❌ | ❌ |
| `export:run` | ✅ | ✅ | ✅ | ❌ | ❌ |
| `sync:manual` | ✅ | ✅ | ❌ | ❌ | ❌ |
| `integration:manage` | ✅ | ❌ | ❌ | ❌ | ❌ |
| `apimonitoring:view` | ✅ | ✅ | ❌ | ❌ | ❌ |
| `audit:view` | ✅ | ❌ | ❌ | ❌ | ❌ |
| `user:manage` | ✅ | ❌ | ❌ | ❌ | ❌ |
| `loadtest:run` | ✅ | ❌ | ❌ | ❌ | ❌ |
| `sync:view` | ✅ | ✅ | ✅ | ❌ | ❌ |
| `sync:bulk` | ✅ | ✅ | ❌ | ❌ | ❌ |
| `sync:cancel` | ✅ | ✅ | ❌ | ❌ | ❌ |
| `sync:retry` | ✅ | ✅ | ❌ | ❌ | ❌ |
| `sync:admin` | ✅ | ❌ | ❌ | ❌ | ❌ |
| `queue:view` | ✅ | ✅ | ✅ | ❌ | ❌ |
| `queue:manage` | ✅ | ✅ | ❌ | ❌ | ❌ |
| `worker:view` | ✅ | ✅ | ❌ | ❌ | ❌ |
| `workspace:pause` | ✅ | ✅ | ❌ | ❌ | ❌ |
| `alert:view` | ✅ | ✅ | ✅ | ❌ | ❌ |
| `alert:manage` | ✅ | ✅ | ❌ | ❌ | ❌ |

`ADMINISTRATOR` is granted **all** permissions (`Object.values(PERMISSION)`).

### School scoping (SCHOOL_USER)

`isSchoolScoped` is true when the principal has the `SCHOOL_USER` role. For scoped
users, `schoolScopeFor(principal)` returns the allowed `schoolScopeIds`; if the
list is empty it returns `['__none__']` so the user sees **nothing** (fail-closed).
Unscoped users get `undefined` (no school filter). School scope ids come from the
user's `schoolScopes` records.

### Raw API response — admins only

The `raw:view` permission is granted **only** to `ADMINISTRATOR`. Raw FastTest API
payloads are therefore visible to administrators only.

---

## Phase 3 — Durable sync platform security

The durable sync platform (queue, workers, alerts, Sync Control Center) inherits
every control above and adds the following.

### No secrets in queue payloads

`SyncJob.payload` and the queue in general carry only ids/keys —
`workspaceId`, `registrationId`, `testCodeNormalized`, `subject`, `schoolId` —
**never API keys, tokens, or passwords**. The schema comment for the payload
field states plainly: **"JSON; MUST NOT contain secrets"**.

### No tokens in logs or DB

FastTest session tokens remain in the **in-memory per-workspace token cache**
only; they are never persisted and never returned to clients. The Pino redaction
paths documented above censor `token`/`apiKey`/`authorization`/`cookie`. New
auth-lifecycle fields on `FastTestWorkspace` — `nextTokenRefreshAt`,
`authenticationDurationMs`, `authenticationFailureCount` — store **timing and
counters only**, no secret material.

### RBAC + audit on all operational actions

Every queue/sync/worker/alert **mutation** is permission-gated via
`requirePermission` and audit-logged. Audited actions include `QUEUE_RETRY`,
`QUEUE_CANCEL`, `QUEUE_RETRY_FAILED`, `QUEUE_DEADLETTER_REQUEUE`,
`WORKSPACE_PAUSE`/`WORKSPACE_RESUME`, `JOBTYPE_PAUSE`/`JOBTYPE_RESUME`,
`SYNC_BULK_<action>`, `SYNC_WORKSPACE_BATCH`, `SYNC_SCHOOL_BATCH`,
`SYNC_SUBJECT_BATCH`, `ALERT_ACK`, and `ALERT_RESOLVE`. As everywhere,
`AuditLog.detail` **must never contain secrets**.

### 11 new permissions with conservative defaults

Operators (`OPERATIONS`) get operational control — view/bulk/cancel/retry,
`queue:view`/`queue:manage`, `worker:view`, `workspace:pause`,
`alert:view`/`alert:manage` — but **not** `sync:admin` (administrator-only; it
gates dead-letter requeue). `ASSESSMENT_TEAM` gets read-only
`sync:view`/`queue:view`/`alert:view`. `SCHOOL_USER` and `VIEWER` get none.
`sync:admin` is the only administrator-exclusive Phase 3 permission.

### Metrics endpoint token gating

`GET /metrics` is protected by `METRICS_TOKEN` when set — supplied via a Bearer
header or `?token=`; a mismatch returns **401**. It emits only counters/gauges,
**never secrets**. When `METRICS_TOKEN` is blank the endpoint is open, so **set
it in production**.

### Bulk-action max-selection guard

`POST /api/sync/bulk` caps a selection at **500 ids** (`MAX_SELECTION`),
Zod-validated; exceeding it returns **400**. This guards against mass-action
abuse and accidental fleet-wide operations. Batch-by-workspace/school/subject
enqueue a single controlled batch job instead of unbounded fan-out.

### Backend-only FastTest access preserved

The durable-queue worker(s) remain the **sole caller** of FastTest; the frontend
and dashboard pages never call FastTest and never receive keys/tokens. School
scope is still enforced **server-side** on the Sync Control Center and bulk
actions — ids are filtered to the operator's allowed schools, and a school batch
outside scope returns **403**.

---

## Audit logging

`src/services/audit.service.ts` (used by e.g. `auth.routes.ts`)

- Security-relevant actions (such as login attempts) are recorded via the audit
  service.
- FastTest calls are logged to `ApiRequestLog` with endpoint label, method,
  status, timing, and FastTest error code/message — **request bodies and auth
  headers (which carry secrets/tokens) are never stored** (see
  `API_INTEGRATION.md`).
- **Secrets are never logged** in either the audit trail or application logs.

### Pino log redaction

`src/lib/logger.ts` redacts these paths (censor `[REDACTED]`):

```
password, pwd, apiKey, restApiKey, apiToken, token, accessToken, passwordHash,
*.password, *.pwd, *.apiKey, *.apiToken,
req.headers.authorization, req.headers.cookie
```

---

## Input validation, injection & XSS

- **Input validation:** request bodies are validated with **Zod** (e.g.
  `loginSchema` in `auth.routes.ts`: email ≤ 255 chars, password 1–200 chars);
  invalid input returns `400`.
- **SQL injection:** all DB access goes through **Prisma**, which uses
  parameterized queries — no string-concatenated SQL.
- **XSS:** views are rendered with **EJS** (default `<%= %>` escaping) and the
  **CSP** above constrains script/style sources.

---

## Security checklist for production

- [ ] `NODE_ENV=production` (enables prod logger path; `isProd` true).
- [ ] `ENCRYPTION_KEY` set to a real 32-byte value (64-char hex / 32-byte base64),
      **not** the insecure default. Rotating this key makes existing ciphertext
      undecryptable — plan re-encryption.
- [ ] `SESSION_SECRET` set to a strong random value, not the dev default.
- [ ] `SESSION_SECURE_COOKIE=true` and served strictly over **HTTPS**.
- [ ] `BOOTSTRAP_ADMIN_PASSWORD` changed from `ChangeMe!Admin123`; default admin
      credentials rotated after first login.
- [ ] `DATABASE_URL` points at **PostgreSQL** (not the SQLite dev file).
- [ ] `LOAD_TEST_ENABLED=false` (never enable in production).
- [ ] FastTest per-subject keys provided via encrypted DB config / env, never
      hardcoded.
- [ ] Reverse proxy terminates TLS; `trust proxy` remains correct for the deploy.
- [ ] Rate limits reviewed for expected traffic.
- [ ] `METRICS_TOKEN` set to a strong value so `/metrics` is not publicly
      scrapable.
- [ ] Reviewed the 11 Phase 3 permissions and role grants (operators do NOT get
      `sync:admin`).

## What must change before go-live

1. **Default admin password** — `BOOTSTRAP_ADMIN_PASSWORD` (`ChangeMe!Admin123`)
   must be replaced and the seeded admin's password rotated.
2. **`ENCRYPTION_KEY`** — replace the built-in insecure default with a securely
   generated key (see `ENVIRONMENT_VARIABLES.md`).
3. **`SESSION_SECRET`** — replace `dev-insecure-session-secret`.
4. **`SESSION_SECURE_COOKIE=true`** behind HTTPS so session cookies are only sent
   over TLS.
