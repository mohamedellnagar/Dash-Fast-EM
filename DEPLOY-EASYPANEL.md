# Deploying to EasyPanel

This app deploys as **3 services** on EasyPanel:

| Service | What it is | Source | Command |
|---|---|---|---|
| `mysql` | Database | EasyPanel MySQL template | — |
| `web` | Dashboard (HTTP) | this repo (Dockerfile) | *(default)* `node dist/server.js` |
| `worker` | Sync worker | this repo (Dockerfile) | `node dist/workers/sync.worker.js` |

The Docker image runs `prisma migrate deploy` automatically on start, and the web
service seeds permissions/roles/admin on first boot — no manual DB setup needed.

---

## 1. Create the MySQL service

EasyPanel → **+ Service → MySQL**. Note the credentials it gives you. Internally
the host is the service name (e.g. `mysql`). Build the connection string:

```
mysql://USER:PASSWORD@mysql:3306/DBNAME
```

> If the password has special characters (`@ : / #`), URL-encode them
> (`@` → `%40`). Example: password `P@ss:w0rd` → `P%40ss%3Aw0rd`.

---

## 2. Create the `web` service (App)

EasyPanel → **+ Service → App**.

- **Source**: GitHub → `mohamedellnagar/Dash-Fast-EM`, branch `main`.
- **Build**: Dockerfile (auto-detected).
- **Port / Proxy**: container port **3000**; add a domain and enable HTTPS.
- **Environment** (see the table below).

## 3. Create the `worker` service (App)

Same repo/Dockerfile, but:

- **No domain / no exposed port** (it's a background worker).
- **Command override**: `node dist/workers/sync.worker.js`
- Give it the **same environment** as `web` (same `DATABASE_URL`, `ENCRYPTION_KEY`, etc.).

---

## 4. Environment variables

Required for production (set on **both** web and worker):

| Variable | Value | Notes |
|---|---|---|
| `NODE_ENV` | `production` | |
| `PORT` | `3000` | must match the container port |
| `DATABASE_URL` | `mysql://USER:PASS@mysql:3306/DBNAME` | from step 1 |
| `ENCRYPTION_KEY` | 64 hex chars | `openssl rand -hex 32` — **encrypts stored API keys; never change after first use** |
| `SESSION_SECRET` | long random string | `openssl rand -hex 32` |
| `SESSION_SECURE_COOKIE` | `true` | required behind HTTPS |
| `BOOTSTRAP_ADMIN_EMAIL` | your admin email | first-login account |
| `BOOTSTRAP_ADMIN_PASSWORD` | strong password | **change from the default** |

Timezones (defaults suit a UAE deployment):

| Variable | Default | Notes |
|---|---|---|
| `DISPLAY_TZ` | `Asia/Dubai` | zone every exam time is shown in |
| `FASTTEST_SOURCE_TZ` | `America/Chicago` | fallback only — the real setting is **per workspace** in Integration Settings, because FastTest's timezone differs between workspaces |
| `SYNC_TZ` | `Asia/Dubai` | zone the daily sync window is evaluated in |

Optional (sensible defaults exist): `SYNC_ENABLED`, `SCHEDULER_ENABLED`,
`LOG_LEVEL`, `FASTTEST_*` rate/timeout tuning. See `.env.example` for the full list.
FastTest workspaces/API keys are configured **in-app** (Integration Settings), not via env.

> Generate the two secrets once and keep them safe:
> ```
> openssl rand -hex 32   # ENCRYPTION_KEY
> openssl rand -hex 32   # SESSION_SECRET
> ```

---

## 5. Deploy & verify

1. Deploy `mysql`, then `web`, then `worker`.
2. Health check: `https://YOUR-DOMAIN/health` → `{"status":"ok"}`.
3. Open the domain, sign in with `BOOTSTRAP_ADMIN_EMAIL` / `BOOTSTRAP_ADMIN_PASSWORD`.
4. Go to **Integration Settings** and configure your FastTest workspace(s) + API keys.

## Updating

Push to `main` → GitHub Actions builds the image → redeploy the `web` and
`worker` services in EasyPanel. Migrations apply automatically on start.

Order matters when both services run: redeploy **`web` first** (it applies the
migrations), then `worker`.

### After upgrading to v0.2.0 — exam timezones

v0.2.0 converts FastTest's exam timestamps to local time. FastTest records them
on a US clock and sends them with no timezone, and **the setting differs per
workspace** — verified against their portal, some record in UTC and some in US
Central. Two steps are needed once, after the deploy:

**1. Set each workspace's source zone**

Integration Settings → *Exam-time source* column. For the current estate:

| Workspace | Source zone |
|---|---|
| Math, Arabic | `UTC` |
| Baseline, English | `America/Chicago` |

Confirm a value by opening any Test Code in the FastTest portal and comparing
its *Time Started* with what Manual Verification shows for the same code.

**2. Convert the stored history**

New syncs convert automatically; rows synced before the upgrade do not. In the
**web** service console:

```
npm run backfill:exam-times -- --dry-run   # review the outcome first
npm run backfill:exam-times                # apply
```

Reads only the vendor strings already stored — it makes **no FastTest API
calls** — and takes roughly 3 minutes for ~70k rows. It is idempotent: re-run it
any time a workspace's source zone changes.

Until it runs, Activity-by-Hour is empty and *Actual Start* shows `—` for older
records. Nothing is lost: the original vendor string is never overwritten, so
the conversion can be redone or corrected at any point.

### Behaviour change in v0.2.0

Switching an academic year **OFF** now cancels everything queued for it, so the
queue drops to zero immediately. Previously the backlog kept draining. The UI
asks for confirmation and reports how many jobs were cancelled.
