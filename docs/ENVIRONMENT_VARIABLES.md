# Environment Variables

Complete reference for every environment variable read by the **FastTest Live
Monitoring & Analytics Dashboard**. Source of truth: `src/config/env.ts` and
`.env.example`.

Loading & parsing rules (`src/config/env.ts`):

- Variables are loaded from `.env` via `dotenv`.
- **Required** = the app throws `Missing required environment variable: <KEY>` at
  startup if unset **and** no fallback is defined. Where a fallback exists the var
  is optional (the default is used). Empty string (`""`) is treated as unset.
- `int(...)` throws if the value is present but non-numeric.
- `bool(...)` is true for `1`, `true`, `yes`, `on` (case-insensitive); anything
  else is false.

> Note: several defaults exist purely for local development and are **insecure**.
> See `SECURITY.md` for the go-live checklist. "Required?" below marks whether the
> value must be set explicitly in production even though a dev fallback exists.

---

## Runtime

| Name | Purpose | Default | Required? | Example |
|---|---|---|---|---|
| `NODE_ENV` | Runtime mode; `production` sets `isProd` and the prod logger path | `development` | No | `production` |
| `PORT` | HTTP listen port | `3000` | No | `3000` |
| `LOG_LEVEL` | Pino log level | `info` | No | `debug` |

## Database

| Name | Purpose | Default | Required? | Example |
|---|---|---|---|---|
| `DATABASE_URL` | Prisma connection string | `file:./dev.db` | Prod: yes | see below |

- **SQLite (dev/test, zero external dependency):** `DATABASE_URL="file:./dev.db"`
- **PostgreSQL (production):**
  `DATABASE_URL="postgresql://user:pass@localhost:5432/fasttest?schema=public"`
  (and set `PRISMA_PROVIDER=postgresql` per the `prisma/schema.prisma` note).

## Security

| Name | Purpose | Default | Required? | Example |
|---|---|---|---|---|
| `ENCRYPTION_KEY` | AES-256-GCM key for encrypting workspace secrets at rest (32 bytes: hex/base64, else SHA-256-hashed) | `dev-insecure-key-...` (insecure) | **Yes (prod)** | `9f8e...` (64 hex chars) |
| `SESSION_SECRET` | Signs session cookies (`express-session` + `cookie-parser`) | `dev-insecure-session-secret` (insecure) | **Yes (prod)** | `a1b2...` (random) |
| `SESSION_SECURE_COOKIE` | Send session cookie only over HTTPS (`cookie.secure`) | `false` | **Yes (prod → `true`)** | `true` |
| `SESSION_MAX_AGE_MS` | Session idle lifetime in ms (rolling) | `3600000` (1h) | No | `3600000` |

### Generating `ENCRYPTION_KEY` and `SESSION_SECRET`

Both accept a 32-byte random value. Generate with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Run it once for `ENCRYPTION_KEY` and again for `SESSION_SECRET`. `ENCRYPTION_KEY`
also accepts base64 (decoding to exactly 32 bytes); any other string is SHA-256
hashed to 32 bytes, but a 64-char hex value is recommended.

## Bootstrap admin

Used by the seed script to create the initial administrator if not present.

| Name | Purpose | Default | Required? | Example |
|---|---|---|---|---|
| `BOOTSTRAP_ADMIN_EMAIL` | Seed admin email | `admin@fasttest.local` | No | `admin@example.com` |
| `BOOTSTRAP_ADMIN_PASSWORD` | Seed admin password — **change before go-live** | `ChangeMe!Admin123` (insecure) | **Yes (prod)** | `<strong password>` |

## FastTest API

| Name | Purpose | Default | Required? | Example |
|---|---|---|---|---|
| `FASTTEST_BASE_URL` | Default FastTest API base URL (per-workspace URL overrides this) | `https://uae.fasttestweb.com/FastTest/api` | No | same |
| `FASTTEST_AUTH_USERNAME` | Default auth username for `/auth/simple` | `""` (empty) | No | `svc_user` |
| `FASTTEST_AUTH_PASSWORD` | Default auth password for `/auth/simple` | `""` (empty) | No | `<password>` |
| `FASTTEST_TOKEN_TTL_SECONDS` | Requested/assumed token TTL | `3600` | No | `3600` |
| `FASTTEST_TOKEN_REFRESH_MARGIN_SECONDS` | Refresh a cached token this many seconds before expiry | `300` | No | `300` |
| `FASTTEST_REQUEST_TIMEOUT_MS` | Per-request HTTP timeout | `15000` | No | `15000` |

## Per-subject REST API keys

Seeded into the DB **encrypted** to bootstrap workspaces. Leave blank to configure
later in the Integration Settings admin UI. Never hardcode in source.

| Name | Purpose | Default | Required? | Example |
|---|---|---|---|---|
| `FASTTEST_KEY_ARABIC` | Arabic workspace REST API key | `""` (empty) | No | `WSzq...NU8w` |
| `FASTTEST_KEY_ENGLISH` | English workspace REST API key | `""` (empty) | No | `WSzq...NU8w` |
| `FASTTEST_KEY_MATH` | Math workspace REST API key | `""` (empty) | No | `WSzq...NU8w` |
| `FASTTEST_KEY_SCIENCE` | Science workspace REST API key | `""` (empty) | No | `WSzq...NU8w` |

## Sync worker

| Name | Purpose | Default | Required? | Example |
|---|---|---|---|---|
| `SYNC_ENABLED` | Enable the background sync worker | `true` | No | `true` |
| `SYNC_WORKER_CONCURRENCY` | Parallel sync workers | `4` | No | `4` |
| `SYNC_TICK_INTERVAL_MS` | Worker tick interval (ms) | `15000` | No | `15000` |
| `SYNC_MAX_BATCH` | Max items processed per tick | `50` | No | `50` |
| `FASTTEST_RATE_LIMIT_PER_MINUTE` | Outbound FastTest request rate cap per minute | `120` | No | `120` |
| `SYNC_MAX_RETRIES` | Max retries for a failing sync item | `3` | No | `3` |

## Load testing

| Name | Purpose | Default | Required? | Example |
|---|---|---|---|---|
| `LOAD_TEST_ENABLED` | Enable the load-testing module — **never enable in production** | `false` | No | `false` |
