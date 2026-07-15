# Implementation Plan & Phase Status

This document is the living plan for the FastTest Live Monitoring & Analytics
Dashboard. It records the phased delivery, what is complete, and what remains.

## Approach

Greenfield build (the repository was empty). Stack selected for a cohesive,
secure, testable, and **locally runnable/verifiable** system:

| Concern | Choice | Rationale |
|---|---|---|
| Language | TypeScript (Node 20) | Type safety, single language front-to-back |
| HTTP | Express 4 | Mature, minimal, easy to test with supertest |
| ORM / DB | Prisma; SQLite (dev/test), PostgreSQL (prod) | Same schema both engines; SQLite needs zero external services so migrations + tests run anywhere; Postgres for scale |
| Views | EJS server-rendered + JSON API | Runnable/verifiable in one process now; the JSON API lets a richer SPA be added later without backend changes |
| Validation | Zod | Runtime input validation at the edges |
| Logging | Pino (+ pino-http) | Structured JSON logs, correlation IDs, secret redaction |
| Tests | Vitest + supertest | Fast; mock transport keeps FastTest out of CI |
| Secrets | AES-256-GCM | Encrypt workspace API keys/credentials at rest |
| AuthN | Session cookies + bcrypt | Simple, secure, no third-party dependency |

## Phase 1 — COMPLETE ✅ (implemented & verified)

- [x] Repository audit (empty repo confirmed)
- [x] Architecture + database design (21 Prisma models)
- [x] Environment setup (`src/config/env.ts`, `.env.example`, generated secrets)
- [x] AES-256-GCM secret encryption + masking (`src/lib/crypto.ts`)
- [x] Authentication (bcrypt, sessions) + login rate limiting + audit
- [x] RBAC (5 roles, permission matrix, school scoping) + middleware
- [x] Workspace configuration model + resolver (subject alias → workspace)
- [x] Student data model + schools/subjects
- [x] Excel/CSV import (validation, preview, upsert, error report, BOM CSV)
- [x] TestCode normalization (`src/lib/testcode.ts`)
- [x] FastTest authentication (`POST /auth/simple`) + per-workspace token cache w/ refresh
- [x] Status endpoint integration + status→dashboard mapping
- [x] Results endpoint integration + calculated fields + score persistence (brought forward from Phase 2)
- [x] Background sync service + policy (polling cadences, retry backoff, permanent-error handling)
- [x] Sync worker (batching, bounded concurrency, per-minute rate limiter)
- [x] Dashboards: Executive, Live Monitoring, Student Details
- [x] API Monitoring, Integration Settings, Import Center, Audit Log, Export (CSV/XLSX)
- [x] Health endpoints (`/health`, `/health/database`, `/health/queue`, `/health/fasttest`)
- [x] 58 automated tests (unit + integration, mock transport) — all passing
- [x] Deployment artifacts (Dockerfile, docker-compose, k6 load-test scaffold)
- [x] Documentation set

## Phase 2 — COMPLETE ✅ (implemented & verified)

- [x] Results integration, score persistence, calculated fields (Phase 1)
- [x] Denormalized result dimensions (schoolId/subjectId/grade/examSubject + primary score) for efficient aggregation
- [x] **Schools Dashboard** + School Details drill-down
- [x] **Subject Dashboard** + Subject Details + workspace health
- [x] Backend analytics endpoints (`/api/dashboard/*`) — DB aggregation, no browser compute
- [x] Advanced server-side filters (25+ fields, validated, URL-persisted, scope-enforced)
- [x] Saved views (CRUD, default, shared/private, duplicate) + per-user table preferences
- [x] Configurable column selection (show/hide/reorder/restore defaults)
- [x] Export presets (14) with CSV/XLSX, formula-injection prevention, scope + column + sort aware, export history
- [x] Students Requiring Attention queue (10 issue types, detection, assign/resolve/notes)
- [x] PII masking (Emirates ID) gated by permission
- [x] 121 automated tests passing (up from 58)

## Phase 3 — COMPLETE ✅ (durable sync platform, implemented & verified)

- [x] Durable DB-backed job queue (12 job types, priorities, delayed retries, dedup, dead-letter, cancellation)
- [x] Distributed locking (atomic row-claim + DistributedLock table: owner/expiry/heartbeat/takeover)
- [x] Smart polling scheduler (nextSyncAt/priority/activeWindow/stale/fetch-needs; stops polling completed+results)
- [x] Workspace-aware rate limiting (rps/rpm/concurrency/min-delay/burst, per-endpoint, global ceiling)
- [x] Adaptive throttling (rolling p50/p95/p99 + error rate → throttle multiplier, gradual recovery)
- [x] Token lifecycle (per-workspace cache, single-flight + distributed refresh lock, lifecycle fields)
- [x] Batch synchronization (workspace/school/subject/active-exam fan-out, fair scheduling)
- [x] Formal sync-state machine (15 states, validated transitions, persisted history)
- [x] Circuit breaker per workspace (CLOSED/OPEN/HALF_OPEN, thresholds, probe recovery)
- [x] Error classification (13 categories, retryability, severity, action)
- [x] Retry strategy per category (backoff + full jitter, permanent-error handling)
- [x] Worker management (registry, heartbeats, health, graceful shutdown, stalled recovery)
- [x] Queue Monitoring Dashboard + Sync Control Center + Worker Health + Sync History + Alerts pages
- [x] Stale-data detection surfaced across Monitoring/Schools/Subjects/Attention/Sync Control
- [x] Alerts (10 types, dedupe, ack/resolve/notes, extensible hooks) + detectors
- [x] Metrics (Prometheus `/metrics`, token-gated) + queue/health snapshots + caching
- [x] Retention cleanup (configurable, preserves active jobs + unresolved alerts)
- [x] 11 new permissions with conservative role defaults
- [x] 190 tests passing; queue benchmark proves exactly-once at 10/100/1000/10000 scale

## Phase 4 — Admin & security hardening

- [x] Integration settings, audit logs (core done)
- [ ] User management UI (create users/assign roles/school scopes)
- [ ] Alerts/notifications
- [ ] Saved views, per-role page restrictions refinements
- [ ] Additional security hardening (CSRF tokens on state-changing forms, 2FA)

## Phase 5 — Load, performance, deployment readiness

- [x] k6 load-test script (disabled by default, tiered, authorization-gated)
- [ ] In-app load-testing module with tiered runs + metrics dashboard
- [ ] Performance tuning (query profiling, caching layer)
- [ ] Full E2E browser tests
- [ ] Production deployment dry run

## Critical risks & assumptions

See the "Known limitations" and "Risks" sections of the final report and
`docs/TROUBLESHOOTING.md`. Key items:

1. **FastTest API response shapes are assumed** from the specification; the
   client persists the full raw JSON and never discards unknown fields, so
   real-world variations are captured for reconciliation. Verify against a live
   sandbox before go-live via the opt-in live test.
2. **Provider switch (SQLite→Postgres)** requires editing the Prisma datasource
   `provider` and running `prisma migrate deploy` against Postgres.
3. **Single-worker assumption** today; multi-worker needs the job-queue wiring
   in Phase 3.
4. **No live credentials** are bundled; workspaces seed without API keys and
   with sync disabled until keys are entered in Integration Settings.
