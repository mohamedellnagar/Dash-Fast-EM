# FastTest Live Monitoring & Analytics Dashboard

A server-rendered Node.js/TypeScript application that integrates internal student
exam-registration data with multiple **FastTest** workspaces over the FastTest REST
API. A background sync worker continuously polls FastTest, normalizes and persists
each registration's live status and results into the application database, and the
dashboard reads **only** from that database — dashboard users never call FastTest
directly.

---

## Features

- **Executive dashboard** — KPIs (total registered, status breakdown, completion
  rate, sync success rate, average response time, average time-used, average raw /
  scaled score), registrations-by-subject and completion-by-school aggregates.
- **Live monitoring** — paginated, filterable, sortable registration table backed
  entirely by the local DB (fast reads, no live API calls per page load). *(Phase 2:
  upgraded with 25+ advanced server-side filters, per-user column selection, and
  saved views.)*
- **Schools & Subject analytics (Phase 2)** — Schools Dashboard (`/schools`) and
  School Details (`/schools/:id`), Subject Dashboard (`/subjects`) and Subject
  Details (`/subjects/:subject`): per-school and per-subject KPIs, status
  distributions, completion-by-grade, score distributions, durations, and
  completion trends. All aggregates are computed in the database and shared with
  the same filter as the table so KPIs always match.
- **Students Requiring Attention (Phase 2)** — an operational queue (`/attention`)
  that classifies registrations into 10 issue types (API not found, workspace
  mapping missing, auth failure, stale status, no results after completion, status
  conflict, missing student mapping, sync failed after max retries, …), with
  assign / acknowledge / resolve, notes, and a Recompute Queue action that
  auto-resolves items no longer applicable.
- **Reports & Export (Phase 2)** — a Reports & Export page (`/export`) with 14
  export presets (all / current filter / per-status / API errors / school summary /
  subject summary / results summary / attention), CSV or XLSX output, column- and
  scope-aware, with export job history.
- **Student / registration detail** — per-registration view with the latest status
  snapshots, results, subscores, and (with permission) the raw FastTest payload.
- **Background sync worker** — polls FastTest on a status-aware cadence, stores a
  full status snapshot per fetch, fetches results once for terminal statuses, and
  denormalizes latest status onto each registration for fast dashboard reads.
- **Multi-workspace FastTest integration** — one workspace per subject (Arabic,
  English, Math, Science, …), each with its own encrypted REST API key and cached
  session token.
- **TestCode normalization** — source codes like `FUJ-290-263-565` are normalized
  to `FUJ290263565` for API calls while the original is always preserved.
- **Data import** — CSV/XLSX upload with preview (validate-only) and commit
  (upsert), per-row validation, in-file duplicate detection, and a downloadable
  error report.
- **Export** — registrations to CSV or XLSX (UTF-8 BOM so Excel renders Arabic).
- **Integration settings (admin)** — create/configure workspaces, manage subject
  alias mappings, and run a connection test that authenticates without ever
  returning the token to the client.
- **API monitoring** — every outbound FastTest call is logged (endpoint, method,
  status, latency, error) and surfaced with aggregate stats.
- **Audit log** — logins, imports, manual syncs, exports, and config changes are
  recorded (never with secrets).
- **RBAC** — session auth with five roles and permission-gated routes and nav.
  *(Phase 2 adds `attention:view`, `attention:manage`, `savedview:share`, and
  `pii:unmask`; Emirates ID is masked unless the role holds `pii:unmask`.)*
- **Security** — bcrypt password hashing, AES-256-GCM encryption of workspace
  secrets at rest, Helmet CSP, rate limiting, signed HTTP-only session cookies.
- **Durable sync platform (Phase 3)** — promotes sync into a durable, observable,
  rate-limited, horizontally-scalable near-real-time platform via a database-backed
  durable queue (no Redis; portable SQLite↔Postgres) with atomic row-claim locking.
  New pages: Queue Monitoring (`/admin/queue`), Sync Control Center (`/sync`),
  Worker Health (`/admin/workers`), Sync History (`/admin/sync-history`), Alerts
  (`/admin/alerts`), and a token-gated Prometheus `/metrics` endpoint. The
  background worker is now a durable-queue processor scalable with multiple
  instances (heartbeats, scheduler, graceful shutdown, stalled recovery).
- **Health checks** — `/health`, `/health/database`, `/health/queue`,
  `/health/fasttest`.

---

## Tech stack

| Layer            | Technology                                               |
|------------------|----------------------------------------------------------|
| Runtime          | Node.js 20+                                              |
| Language         | TypeScript 5                                             |
| Web framework    | Express 4                                                |
| ORM              | Prisma 5 (SQLite for dev/test, PostgreSQL for prod)      |
| Views            | EJS server-rendered templates                            |
| Validation       | Zod                                                     |
| Logging          | Pino + pino-http (correlation-id per request)           |
| Auth             | express-session (cookie) + bcryptjs                     |
| Crypto           | Node `crypto` AES-256-GCM                               |
| Uploads          | Multer + xlsx / csv-parse                               |
| Security         | Helmet, express-rate-limit, compression                 |
| Testing          | Vitest + Supertest (**190 passing tests across 31 files**) |

The Prisma schema is intentionally **provider-agnostic**: no native DB enums
(statuses are `String` columns validated in code), raw payloads stored as `String`,
numerics as `Float`. Only the `datasource` block changes between SQLite and Postgres.

---

## Prerequisites

- **Node.js 20+**
- **npm**
- A database:
  - Dev/test: **SQLite** (zero external dependency — default).
  - Production: **PostgreSQL** (switch the Prisma `provider` and `DATABASE_URL`).

---

## Quick start

```bash
# 1. Install dependencies
npm install

# 2. Create your environment file
cp .env.example .env

# 3. Generate real secrets and paste them into .env
#    ENCRYPTION_KEY  (32-byte key, hex)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
#    SESSION_SECRET
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# 4. Create the database schema
npx prisma migrate deploy      # apply existing migrations (prod-style)
# or, for a dev database with migration authoring:
npm run prisma:migrate         # applies all migrations, including the Phase 2
                               # analytics migration 20260713070938_phase2_analytics
                               # (saved views, exports, attention queue, and the
                               # denormalized FastTestResult analytics columns)
                               # and the Phase 3 durable-sync migration
                               # 20260713080816_phase3_durable_sync (13 new models,
                               # expanded SyncJob, new ExamRegistration /
                               # FastTestWorkspace columns)

# 5. Seed roles, permissions, subjects, workspaces, and the bootstrap admin
npm run db:seed

# 6. Start the web app
npm run dev

# 7. (In a second terminal) start the background sync worker
npm run worker
```

Then open **http://localhost:3000** and sign in:

- **Email:** `admin@fasttest.local` (value of `BOOTSTRAP_ADMIN_EMAIL`)
- **Password:** the value of `BOOTSTRAP_ADMIN_PASSWORD` in your `.env`
  (defaults to `ChangeMe!Admin123`)

> ⚠️ **Change the default admin password immediately.** The bootstrap credentials
> are for first login only and must not be used in any shared or production
> environment.

FastTest REST API keys can be left blank in `.env` and configured later in the
**Integration Settings** admin page; keyless workspaces are seeded with sync
disabled until a key is provided.

---

## npm scripts

| Script                  | Command                                             | Purpose                                              |
|-------------------------|-----------------------------------------------------|------------------------------------------------------|
| `npm run build`         | `tsc` + copy views/public into `dist/`              | Compile TypeScript for production                    |
| `npm start`             | `node dist/server.js`                               | Run the compiled web server                          |
| `npm run dev`           | `ts-node-dev … src/server.ts`                       | Run the web server with hot reload                   |
| `npm run worker`        | `ts-node-dev … src/workers/sync.worker.ts`          | Run the background sync worker (dev)                 |
| `npm run worker:prod`   | `node dist/workers/sync.worker.js`                  | Run the compiled sync worker                         |
| `npm run prisma:migrate`| `prisma migrate dev`                                | Create/apply migrations in development               |
| `npm run prisma:deploy` | `prisma migrate deploy`                             | Apply migrations without authoring (prod)            |
| `npm run db:seed`       | `ts-node prisma/seed.ts`                            | Seed roles, permissions, subjects, workspaces, admin |
| `npm run db:reset`      | `prisma migrate reset --force`                      | Drop, re-migrate, and re-seed the database           |
| `npm test`              | `vitest run` (SQLite test DB)                       | Run the full test suite                              |
| `npm run test:watch`    | `vitest`                                            | Run tests in watch mode                              |
| `npm run typecheck`     | `tsc --noEmit`                                       | Type-check without emitting                          |
| `npm run lint`          | `eslint . --ext .ts`                                | Lint the source                                      |

---

## Project structure

```
Dash-Fast-EM/
├── prisma/
│   ├── schema.prisma            # 40 models (provider-agnostic)
│   ├── migrations/              # SQL migrations
│   └── seed.ts                  # roles, permissions, subjects, workspaces, admin
├── src/
│   ├── server.ts                # HTTP bootstrap + graceful shutdown
│   ├── app.ts                   # Express app: middleware, security, routers
│   ├── config/
│   │   └── env.ts               # typed env loader (required-var enforcement)
│   ├── db/
│   │   └── prisma.ts            # shared PrismaClient
│   ├── lib/
│   │   ├── crypto.ts            # AES-256-GCM encrypt/decrypt/mask
│   │   ├── enums.ts             # roles, permissions, statuses, error taxonomy
│   │   ├── logger.ts            # Pino logger
│   │   └── testcode.ts          # TestCode normalization
│   ├── middleware/
│   │   └── auth.ts              # attachPrincipal, requireAuth, requirePermission
│   ├── services/
│   │   ├── auth.service.ts      # bcrypt hashing + login
│   │   ├── rbac.service.ts      # role→permission map, principal loading
│   │   ├── audit.service.ts     # audit log writer
│   │   ├── workspace.service.ts # workspace resolution + secret masking
│   │   ├── analytics.service.ts # KPIs, aggregates, paginated reads
│   │   ├── fasttest/            # REST client, HTTP transport, token cache,
│   │   │                        #   results mapper, types
│   │   ├── sync/                # polling policy + sync service
│   │   └── import/              # CSV/XLSX parse, validate, upsert
│   ├── routes/                  # auth, dashboard, api, import, admin, export, health
│   ├── views/                   # EJS templates + partials
│   ├── public/                  # static assets
│   └── workers/
│       └── sync.worker.ts       # durable-queue processor: heartbeats, scheduler, graceful shutdown
├── tests/                       # unit + integration (Vitest / Supertest)
├── docs/
│   ├── ARCHITECTURE.md
│   └── DATABASE_SCHEMA.md
├── .env.example
└── package.json
```

---

## Dashboard pages

| Page                    | Route                     | Required permission     |
|-------------------------|---------------------------|-------------------------|
| Executive Dashboard     | `/`                       | `dashboard:view`        |
| Live Monitoring         | `/monitoring`             | `monitoring:view`       |
| Schools Dashboard       | `/schools`                | `dashboard:view`        |
| School Details          | `/schools/:id`            | `dashboard:view`        |
| Subject Dashboard       | `/subjects`               | `dashboard:view`        |
| Subject Details         | `/subjects/:subject`      | `dashboard:view`        |
| Students Requiring Attention | `/attention`         | `attention:view`        |
| Reports & Export        | `/export`                 | `export:run`            |
| Student / Detail        | `/registrations/:id`      | `student:view`          |
| Import Center           | `/import`                 | `import:run`            |
| Queue Monitoring        | `/admin/queue`            | `queue:view`            |
| Sync Control Center     | `/sync`                   | `sync:view`             |
| Worker Health           | `/admin/workers`          | `worker:view`           |
| Sync History            | `/admin/sync-history`     | `sync:view`             |
| Alerts & Monitoring     | `/admin/alerts`           | `alert:view`            |
| API Monitoring          | `/admin/api-monitoring`   | `apimonitoring:view`    |
| Integration Settings    | `/admin/integration`      | `integration:manage`    |
| Audit Log               | `/admin/audit`            | `audit:view`            |

Navigation links are shown only for the permissions a user actually holds.

Phase 2 also adds a JSON analytics API under `/api/dashboard/*` (overview,
status-distribution, schools, schools/:id, subjects, subjects/:subject,
completion-trends, scores, durations, api-health), `/api/saved-views`
(+ `/columns`, `/prefs/table`), and `/api/attention*` (list, summary, refresh,
assign, status, notes). Phase 3 also adds JSON APIs under `/api/queue`, `/api/sync`,
and `/api/alerts`, plus a token-gated Prometheus `/metrics` endpoint. See the docs below.

---

## Documentation

- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — high-level architecture, sync
  flow, token caching, error taxonomy, security architecture, provider
  portability, and the Phase 2 analytics & operational layer.
- **[docs/DATABASE_SCHEMA.md](docs/DATABASE_SCHEMA.md)** — all 27 Prisma models,
  their fields, relationships, unique constraints, indexes, and the uniqueness
  rationale.
- **[docs/PHASE_2_IMPLEMENTATION.md](docs/PHASE_2_IMPLEMENTATION.md)** — what the
  Phase 2 analytics & operational layer added (services, routes, views, DB models),
  data-accuracy rules, and security.
- **[docs/DASHBOARD_METRICS.md](docs/DASHBOARD_METRICS.md)** — how each KPI and
  aggregate is defined and computed.
- **[docs/EXPORT_GUIDE.md](docs/EXPORT_GUIDE.md)** — export presets, formats, column
  selection, scope enforcement, and export history.
- **[docs/SAVED_VIEWS.md](docs/SAVED_VIEWS.md)** — advanced filters, saved views,
  and per-user column preferences.
- **[docs/API_DOCUMENTATION.md](docs/API_DOCUMENTATION.md)** — the JSON API,
  including the Phase 2 analytics, saved-views, export, and attention endpoints.
- **[docs/PHASE_3_IMPLEMENTATION.md](docs/PHASE_3_IMPLEMENTATION.md)** — the Phase 3
  durable sync platform: queue technology & rationale, DB changes, services, worker,
  pages/APIs, security, verification.
- **[docs/SYNC_ARCHITECTURE.md](docs/SYNC_ARCHITECTURE.md)** — the durable-queue sync
  architecture (queue + locking, scheduler, rate limiting, adaptive throttle, circuit
  breaker, token lifecycle, worker fleet, observability, state machine).
- **[docs/QUEUE_OPERATIONS.md](docs/QUEUE_OPERATIONS.md)** — operating the durable
  queue (monitoring, actions, dead-letter, pausing).
- **[docs/RATE_LIMITING.md](docs/RATE_LIMITING.md)** — per-workspace rate limiting and
  adaptive throttling.
- **[docs/CIRCUIT_BREAKER.md](docs/CIRCUIT_BREAKER.md)** — per-workspace circuit breaker
  states and recovery.
- **[docs/WORKER_OPERATIONS.md](docs/WORKER_OPERATIONS.md)** — running, scaling, and
  monitoring workers.
- **[docs/ALERTS_AND_MONITORING.md](docs/ALERTS_AND_MONITORING.md)** — alerts, metrics,
  and health snapshots.
- **[docs/DATA_RETENTION.md](docs/DATA_RETENTION.md)** — retention policy and cleanup.

---

## Configuration reference

All configuration is via environment variables (see `.env.example`). Key groups:

- **Runtime:** `NODE_ENV`, `PORT`, `LOG_LEVEL`
- **Database:** `DATABASE_URL`
- **Security:** `ENCRYPTION_KEY`, `SESSION_SECRET`, `SESSION_SECURE_COOKIE`,
  `SESSION_MAX_AGE_MS`
- **Bootstrap admin:** `BOOTSTRAP_ADMIN_EMAIL`, `BOOTSTRAP_ADMIN_PASSWORD`
- **FastTest API:** `FASTTEST_BASE_URL`, `FASTTEST_AUTH_USERNAME`,
  `FASTTEST_AUTH_PASSWORD`, `FASTTEST_TOKEN_TTL_SECONDS`,
  `FASTTEST_TOKEN_REFRESH_MARGIN_SECONDS`, `FASTTEST_REQUEST_TIMEOUT_MS`,
  and per-subject keys `FASTTEST_KEY_ARABIC|ENGLISH|MATH|SCIENCE`
- **Sync worker:** `SYNC_ENABLED`, `SYNC_WORKER_CONCURRENCY`,
  `SYNC_TICK_INTERVAL_MS`, `SYNC_MAX_BATCH`, `FASTTEST_RATE_LIMIT_PER_MINUTE`,
  `SYNC_MAX_RETRIES`. Phase 3 adds scheduling/locking vars (`SCHEDULER_ENABLED`,
  `SCHEDULER_INTERVAL_MS`, `SYNC_JOB_LOCK_TTL_MS`, `SYNC_STALLED_JOB_MS`,
  `WORKER_HEARTBEAT_MS`, `WORKER_STALE_MS`, `SYNC_GLOBAL_MAX_CONCURRENT`),
  per-workspace rate limiting (`RATE_*`), adaptive throttling (`ADAPTIVE_*`),
  circuit breaker (`CIRCUIT_*`), retention (`RETENTION_*`), and observability
  (`METRICS_TOKEN`) — see `.env.example`.
