# Deployment Guide

Production deployment guide for the **FastTest Live Monitoring & Analytics Dashboard**.

The application ships as two long-running Node.js processes built from a single codebase:

| Process | Command | Purpose |
|---------|---------|---------|
| Web server | `node dist/server.js` | Express HTTP app (dashboard, auth, APIs, health) |
| Sync worker | `node dist/workers/sync.worker.js` | Background poller that syncs FastTest status/results |

The same Docker image runs both — the worker just overrides the container command.

---

## 1. Prerequisites

- **Node.js 20+** (`"engines": { "node": ">=20" }` in `package.json`).
- **PostgreSQL** for production (SQLite is used only for dev/test).
- **Docker + Docker Compose** (optional, for the containerized stack in `docker-compose.yml`).
- Network egress to the FastTest API base URL (default `https://uae.fasttestweb.com/FastTest/api`).

---

## 2. Switch Prisma from SQLite to PostgreSQL

The schema is written to be provider-agnostic (no native DB enums, raw payloads stored as `String`, all numerics `Float`). **Only the datasource block changes between environments** — see the portability note at the top of `prisma/schema.prisma`.

Edit `prisma/schema.prisma`:

```prisma
datasource db {
  provider = "postgresql"   // was: "sqlite"
  url      = env("DATABASE_URL")
}
```

Then set `DATABASE_URL` to a Postgres connection string:

```bash
DATABASE_URL="postgresql://fasttest:CHANGE_ME@db-host:5432/fasttest?schema=public"
```

(The `docker-compose.yml` header documents the same switch and provides a ready-made Compose Postgres URL: `postgresql://fasttest:fasttest@db:5432/fasttest?schema=public`.)

After switching the provider, regenerate the Prisma client:

```bash
npm run prisma:generate
```

---

## 3. Environment configuration & secrets

All configuration is read through `src/config/env.ts` via environment variables (loaded with `dotenv`). **Never commit `.env`** — copy `.env.example` to `.env` and populate real secrets there, or inject variables through your orchestrator's secret store.

Key variables (defaults shown are dev-insecure and **must** be overridden in production):

| Variable | Default | Notes |
|----------|---------|-------|
| `NODE_ENV` | `development` | Set to `production` |
| `PORT` | `3000` | Web server port |
| `LOG_LEVEL` | `info` | Pino log level |
| `DATABASE_URL` | `file:./dev.db` | **Set to your Postgres URL** |
| `ENCRYPTION_KEY` | dev-insecure key | AES-256-GCM key for workspace secrets — **must change** |
| `SESSION_SECRET` | dev-insecure secret | Express session secret — **must change** |
| `SESSION_SECURE_COOKIE` | `false` | Set `true` behind HTTPS |
| `SESSION_MAX_AGE_MS` | `3600000` | Session lifetime |
| `BOOTSTRAP_ADMIN_EMAIL` | `admin@fasttest.local` | Seeded admin login |
| `BOOTSTRAP_ADMIN_PASSWORD` | `ChangeMe!Admin123` | **Change before first run** |
| `FASTTEST_BASE_URL` | `https://uae.fasttestweb.com/FastTest/api` | FastTest API root |
| `FASTTEST_AUTH_USERNAME` / `FASTTEST_AUTH_PASSWORD` | empty | FastTest credentials |
| `FASTTEST_TOKEN_TTL_SECONDS` | `3600` | Token cache TTL |
| `FASTTEST_TOKEN_REFRESH_MARGIN_SECONDS` | `300` | Refresh-ahead margin |
| `FASTTEST_REQUEST_TIMEOUT_MS` | `15000` | Per-request timeout |
| `FASTTEST_KEY_ARABIC` / `_ENGLISH` / `_MATH` / `_SCIENCE` | empty | Per-subject workspace API keys |
| `SYNC_ENABLED` | `true` | Master switch for the worker |
| `SYNC_WORKER_CONCURRENCY` | `4` | Concurrent registration syncs per tick |
| `SYNC_TICK_INTERVAL_MS` | `15000` | Worker poll interval |
| `SYNC_MAX_BATCH` | `50` | Registrations selected per tick |
| `FASTTEST_RATE_LIMIT_PER_MINUTE` | `120` | Worker request rate cap |
| `SYNC_MAX_RETRIES` | `3` | Retry ceiling |
| `LOAD_TEST_ENABLED` | `false` | Load-testing safety flag (keep `false` in prod) |

> **Phase 3 durable-sync vars** — the durable queue, scheduler, worker fleet, rate limiting, adaptive throttling, circuit breaker, retention, and `/metrics` protection. See `.env.example` for the authoritative full list.

| Variable | Default | Notes |
|----------|---------|-------|
| `SCHEDULER_ENABLED` | `true` | Enable the scheduler tick |
| `SCHEDULER_INTERVAL_MS` | `30000` | Scheduler tick interval |
| `SYNC_JOB_LOCK_TTL_MS` | `60000` | Job lock TTL / per-job heartbeat base |
| `SYNC_STALLED_JOB_MS` | `120000` | Reclaim jobs stalled beyond this |
| `WORKER_HEARTBEAT_MS` | `10000` | Worker heartbeat interval |
| `WORKER_STALE_MS` | `30000` | Mark a worker `STALE` past this |
| `SYNC_GLOBAL_MAX_CONCURRENT` | `16` | Global in-flight cap across the fleet |
| `RATE_MAX_RPS` | `2` | Per-workspace rate limiting (conservative; FastTest limits **not** assumed) |
| `RATE_MAX_RPM` | `60` | Per-workspace requests-per-minute cap |
| `RATE_MAX_CONCURRENT` | `3` | Per-workspace concurrent request cap |
| `RATE_MIN_DELAY_MS` | `200` | Minimum delay between per-workspace requests |
| `RATE_BURST` | `5` | Per-workspace burst allowance |
| `RATE_COOLDOWN_MS` | `30000` | Per-workspace cooldown window |
| `ADAPTIVE_ENABLED` | `true` | Adaptive throttling on/off |
| `ADAPTIVE_LATENCY_MS` | `4000` | Latency threshold that triggers throttling |
| `ADAPTIVE_ERROR_RATE` | `0.2` | Error-rate threshold that triggers throttling |
| `ADAPTIVE_RECOVER_MS` | `60000` | Recovery window before easing throttle |
| `ADAPTIVE_MIN_THROTTLE` | `0.25` | Floor for the adaptive throttle factor |
| `CIRCUIT_FAILURE_THRESHOLD` | `5` | Per-workspace failures before the breaker opens |
| `CIRCUIT_TIMEOUT_THRESHOLD` | `3` | Per-workspace timeouts before the breaker opens |
| `CIRCUIT_AUTH_THRESHOLD` | `3` | Per-workspace auth failures before the breaker opens |
| `CIRCUIT_OPEN_MS` | `60000` | How long the breaker stays open |
| `CIRCUIT_HALFOPEN_PROBES` | `2` | Probe requests allowed in half-open state |
| `RETENTION_API_LOGS_DAYS` | `90` | API log retention (days) |
| `RETENTION_COMPLETED_JOBS_DAYS` | `30` | Completed-job retention (days) |
| `RETENTION_FAILED_JOBS_DAYS` | `180` | Failed-job retention (days) |
| `RETENTION_HEARTBEAT_DAYS` | `30` | Worker-heartbeat retention (days) |
| `RETENTION_METRICS_DAYS` | `90` | Metrics retention (days) |
| `RETENTION_AUDIT_DAYS` | `365` | Audit-log retention (days). Active jobs / unresolved alerts are never deleted |
| `METRICS_TOKEN` | empty | Token protecting `GET /metrics` (blank = open; **set in production**) |

> **Zero-secret-commit rule:** `ENCRYPTION_KEY`, `SESSION_SECRET`, `BOOTSTRAP_ADMIN_PASSWORD`, `FASTTEST_AUTH_*`, and the `FASTTEST_KEY_*` values are secrets. Keep them in `.env` (git-ignored) or a secret manager. Workspace API keys/usernames/passwords are stored **encrypted** in the database (AES-256-GCM, `restApiKeyEncrypted` etc.) and are never returned to clients in raw form.

---

## 4. Build, migrate, seed

```bash
# Install and generate the Prisma client
npm ci
npm run prisma:generate

# Compile TypeScript and copy views/public into dist/
npm run build

# Apply migrations to the production database (no dev prompts)
npx prisma migrate deploy      # or: npm run prisma:deploy

# Seed baseline data (roles, permissions, subjects, workspaces, bootstrap admin)
npm run db:seed
```

`npm run build` runs `tsc -p tsconfig.json` and then copies `src/views` and `src/public` into `dist/`.

> **Phase 3 migration:** `npx prisma migrate deploy` applies **all** pending migrations, including the Phase 3 migration `20260713080816_phase3_durable_sync` (durable sync: 13 new models, an expanded `SyncJob`, and new `ExamRegistration` / `FastTestWorkspace` columns). The change is **additive and non-destructive** — no drops.

---

## 5. Run web and worker as separate processes

Run each as its own supervised process (systemd, PM2, container, etc.):

```bash
# Web server
NODE_ENV=production node dist/server.js

# Background sync worker (separate process)
NODE_ENV=production node dist/workers/sync.worker.js
```

The worker (`src/workers/sync.worker.ts`) is a **durable-queue processor**: it registers a `WorkerInstance`, runs a heartbeat loop, drives a bounded pool of atomic-claim job runners, and runs an orchestrator loop for the scheduler, snapshots, alerts, and retention. It handles `SIGTERM`/`SIGINT` for graceful shutdown. If `SYNC_ENABLED=false` the worker starts but idles.

You can run **multiple** workers. `docker compose up --scale worker=N` runs N workers; each claims jobs atomically (no duplicate processing), heartbeats, and recovers peers' stalled jobs. Scheduling is idempotent, so **no leader election is needed** — every worker can run the scheduler safely.

Graceful shutdown **drains in-flight jobs** on `SIGTERM`. In Compose, set `stop_grace_period` (currently `60s` in `docker-compose.yml`) high enough to let long-running jobs finish before the container is killed.

---

## 6. Docker build & Compose

The `Dockerfile` is a multi-stage build that runs as a **non-root** `app` user and includes a container `HEALTHCHECK` hitting `/health`.

```bash
# Build the image
docker build -t fasttest-dashboard .
```

`docker-compose.yml` brings up the full production-like stack — `db` (Postgres 16), `web`, and `worker`:

```bash
cp .env.example .env      # then set real secrets + Postgres DATABASE_URL
# (and set schema.prisma provider to "postgresql")
docker compose up -d --build
```

- **`db`** — Postgres 16 with a `pg_isready` healthcheck and a `pgdata` volume.
- **`web`** — runs `npx prisma migrate deploy && node dist/server.js`, published on `3000`, waits for `db` to be healthy.
- **`worker`** — runs `node dist/workers/sync.worker.js` off the same image, also waiting for `db`. It can be **scaled** (`docker compose up --scale worker=N`) and has `stop_grace_period: 60s` for graceful drain (default `replicas: 1`).

Both `web` and `worker` read secrets from `.env` via `env_file`.

---

## 7. Health checks

The web server exposes four health endpoints (verified by `tests/integration/app.test.ts`):

| Endpoint | Purpose |
|----------|---------|
| `GET /health` | Liveness — returns `{ status: "ok" }` (used by the Docker `HEALTHCHECK`) |
| `GET /health/database` | Reports database reachability (`{ database: "reachable" }`) |
| `GET /health/queue` | Sync queue / worker health |
| `GET /health/fasttest` | Lists configured FastTest workspaces |

Point your load balancer / orchestrator liveness probe at `/health` and readiness at `/health/database`.

---

## 8. Reverse proxy (nginx)

Terminate client connections at a reverse proxy and forward to the Node web process. Because the app sits behind a proxy, enable Express `trust proxy` so client IPs (used in audit logs and rate limiting) resolve from `X-Forwarded-For` rather than the proxy address.

```nginx
server {
    listen 443 ssl;
    server_name dashboard.example.com;

    ssl_certificate     /etc/ssl/certs/dashboard.crt;
    ssl_certificate_key /etc/ssl/private/dashboard.key;

    location / {
        proxy_pass         http://127.0.0.1:3000;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
    }
}
```

In the Express app, set `app.set('trust proxy', 1)` (or the appropriate hop count) so the proxy's forwarded headers are honored.

---

## 9. SSL / HTTPS

- **Terminate TLS at the reverse proxy** (nginx sample above) or your load balancer; the Node processes can remain plain HTTP on the internal network.
- Set **`SESSION_SECURE_COOKIE=true`** in production so session cookies are only sent over HTTPS (`src/config/env.ts` → `sessionSecureCookie`).
- Redirect HTTP → HTTPS at the proxy.

---

## 10. Backups

- Schedule regular **`pg_dump`** backups (e.g. nightly full dump; consider WAL archiving / PITR for tighter RPO):

  ```bash
  pg_dump "$DATABASE_URL" | gzip > /backups/fasttest-$(date +%F).sql.gz
  ```

- **Encrypt backups at rest** (they contain encrypted workspace secrets and audit data). Encrypt the dump before shipping it off-host.
- Define a **retention policy** (e.g. keep 7 daily / 4 weekly / 12 monthly) and prune older archives.
- Periodically **test restores** into a staging database.

---

## 11. Logging

- The app uses **Pino** (`pino` + `pino-http`) emitting **structured JSON to stdout**.
- Do not write logs to files inside the container; let the platform capture stdout and **ship it to a log aggregator** (e.g. Loki, ELK, CloudWatch, Datadog).
- Control verbosity with `LOG_LEVEL` (default `info`).
- Audit-relevant events (`LOGIN`, `LOGIN_FAILED`, `IMPORT`, `MANUAL_SYNC`, `EXPORT`, …) are also persisted to the `AuditLog` table; audit `detail` must never contain secrets.

---

## 12. Scaling notes

- **Web tier:** stateless HTTP — run **multiple `dist/server.js` instances behind a load balancer**. Ensure session storage is compatible with multiple instances (sticky sessions or a shared session store) since sessions are cookie-based.
- **Worker tier — the durable queue supports safe multi-worker scaling:**
  - **Single-node:** one web + one worker sharing the DB — simplest; fine for modest volume.
  - **Multi-worker:** run several worker processes/containers against the same DB for throughput and HA. Atomic row-claim locking guarantees each job runs on **exactly one** worker; idempotent scheduling means every worker can run the scheduler with **no leader election**; peers recover each other's stalled jobs. Bound total in-flight work with `SYNC_GLOBAL_MAX_CONCURRENT` and per-workspace with the `RATE_*` limits.
  - **Horizontal scaling:** scale the stateless web tier behind a load balancer (as described above) **and** scale workers with `docker compose up --scale worker=N`. On Postgres the atomic claim can be hardened with advisory locks; the guarded-`updateMany` claim is the portable default that already prevents duplicate processing.
- Tune throughput with **`SYNC_WORKER_CONCURRENCY`**, `SYNC_MAX_BATCH`, and `SYNC_TICK_INTERVAL_MS`; the `RATE_*`, `ADAPTIVE_*`, and `CIRCUIT_*` vars also tune behavior.
- Respect FastTest limits with **`FASTTEST_RATE_LIMIT_PER_MINUTE`** (worker-side) plus the app's `express-rate-limit` HTTP limits.

---

## 13. Production startup (summary)

```bash
# 1. Configure
cp .env.example .env            # set NODE_ENV=production, DATABASE_URL (postgres),
                                # ENCRYPTION_KEY, SESSION_SECRET, BOOTSTRAP_ADMIN_PASSWORD,
                                # FASTTEST_* keys, SESSION_SECURE_COOKIE=true

# 2. Switch provider to postgresql in prisma/schema.prisma

# 3. Build + migrate + seed
npm ci
npm run prisma:generate
npm run build
npx prisma migrate deploy
npm run db:seed

# 4. Start processes (separately, supervised)
node dist/server.js
node dist/workers/sync.worker.js

# --- or, containerized ---
docker compose up -d --build
```

> **Reminder:** commit **zero secrets**. `.env` stays out of version control; production secrets live in your secret manager.

---

## Rollback note

The Phase 3 migration (`20260713080816_phase3_durable_sync`) is **additive and non-destructive** — new tables plus new nullable/defaulted columns, with **no drops**. Rolling back the **application code** is therefore safe: the new tables and columns are simply left unused by older code.

- Always **back up the DB** (`pg_dump`) before deploying.
- Prisma migrations are **forward-only** in production (`migrate deploy`) — there is no down-migration step.
- To revert the **schema**, restore from a pre-deploy backup.
