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

Push to `main` → redeploy the `web` and `worker` services in EasyPanel. Migrations
apply automatically on start.
