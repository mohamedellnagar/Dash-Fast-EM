# Rate Limiting

Workspace-aware rate limiting for all FastTest traffic. The platform never
assumes FastTest's real limits — defaults are **deliberately conservative** and
tunable per workspace. See [`SYNC_ARCHITECTURE.md`](./SYNC_ARCHITECTURE.md) for
the queue design and [`CIRCUIT_BREAKER.md`](./CIRCUIT_BREAKER.md) for the
per-workspace circuit breaker that complements adaptive throttling.

Implementation: `src/services/sync/rate-limiter.service.ts` (token bucket +
concurrency), `src/services/sync/adaptive.service.ts` (adaptive throttle),
`src/config/env.ts` (defaults).

---

## Two independent controls

Rate limiting has two orthogonal dimensions:

1. **Request pace** — how fast a single worker may *issue* requests to a
   workspace: `maxRps`, `maxRpm`, `minDelayMs`, `burst`. Enforced by an
   **in-process token bucket per worker**.
2. **Concurrency** — how many requests may be *in flight at once*: per-workspace,
   per-endpoint, and a global ceiling. Enforced **distributed-safely in the DB**
   by counting `RUNNING` jobs, so it holds across all workers.

> **Multi-worker note.** Request pace is **per-worker** (each worker has its own
> token bucket), so with *N* workers the effective per-workspace pace is *N ×
> maxRps* unless you divide `RATE_MAX_RPS` / `RATE_MAX_RPM` by the worker count.
> Concurrency, by contrast, is **global** — it is enforced against the shared DB
> `RUNNING` count and does not need dividing.

---

## Token-bucket model

`TokenBucket` (`rate-limiter.service.ts`). Per workspace, a bucket enforces:

| Field | Role |
|---|---|
| `maxRps` | Token refill rate (tokens/second). |
| `maxRpm` | Hard ceiling on grants within a rolling 60 s window. |
| `maxConcurrent` | Default per-workspace concurrent-request cap. |
| `minDelayMs` | Minimum spacing between two grants. |
| `burst` | Bucket capacity — the most tokens available at once. |
| `cooldownMs` | Cooldown window (used with circuit/adaptive recovery). |
| `maxBatch` | Max registrations pulled per batch fan-out. |

`tryAcquire(now, throttle)` grants a request only if **all** hold: enough time
since the last grant (`minDelay`), the minute window isn't full (`< rpm`), and a
token is available (`tokens ≥ 1`). Otherwise it returns `allowed:false` with a
`retryAfterMs` the worker uses to reschedule the job (`RESCHEDULE`, without
consuming a retry).

---

## Per-endpoint concurrency

Concurrency can be capped **per endpoint class** so, e.g., auth calls don't crowd
out status/results. `endpointConcurrency(cfg, endpoint)`:

| Endpoint | Job types | Cap |
|---|---|---|
| `auth` | `AUTHENTICATE_WORKSPACE` | `authMaxConcurrent` (else `maxConcurrent`) |
| `status` | `SYNC_REGISTRATION_STATUS`, `SYNC_REGISTRATION_FULL`, `MANUAL_SYNC` | `statusMaxConcurrent` (else `maxConcurrent`) |
| `results` | `SYNC_REGISTRATION_RESULTS` | `resultsMaxConcurrent` (else `maxConcurrent`) |
| `other` | everything else | `maxConcurrent` |

A `null` per-endpoint override inherits `maxConcurrent`. At claim time,
`claimNext` counts the workspace's `RUNNING` jobs and skips the candidate if it
would exceed the endpoint cap.

---

## Global concurrency ceiling

`claimNext` first checks a **global** cap: if the total number of `RUNNING`
jobs across all workspaces is `≥ SYNC_GLOBAL_MAX_CONCURRENT` (default 16), no new
job is claimed by any worker. This bounds total simultaneous FastTest load
regardless of how many workspaces or workers exist.

---

## Distributed per-workspace concurrency

Per-workspace concurrency is enforced by **counting `RUNNING` `SyncJob` rows for
that workspace in the database** (`currentWorkspaceConcurrency`, and inline in
`claimNext`). Because the count comes from shared DB state, the cap holds across
every worker without any coordination — no Redis, no distributed semaphore. It
also feeds **fair scheduling**: workspaces with fewer running jobs are preferred.

---

## Conservative defaults — FastTest limits are NOT assumed

The system does not know FastTest's true rate limits, so it starts small and lets
operators raise limits per workspace once real headroom is observed. The default
per-workspace config (`defaultRateConfig`) comes from env:

- 2 rps, 60 rpm, 3 concurrent, 200 ms min-delay, burst 5, 30 s cooldown.

These are intentionally low. They are the floor the platform runs at until a
workspace is explicitly configured otherwise.

---

## Per-workspace configuration (`WorkspaceRateLimit`)

Admins can override limits per workspace via the `WorkspaceRateLimit` table
(admin-configurable). `getRateConfig(workspaceId)` returns the row if present,
else the env defaults, cached for 15 s (`invalidateRateConfig` clears the cache —
called automatically when a workspace is paused/resumed).

```prisma
model WorkspaceRateLimit {
  workspaceId          String @id
  maxRps               Float  @default(2)
  maxRpm               Int    @default(60)
  maxConcurrent        Int    @default(3)
  maxBatch             Int    @default(25)
  minDelayMs           Int    @default(200)
  burst                Int    @default(5)
  cooldownMs           Int    @default(30000)
  authMaxConcurrent    Int?   // null → inherit maxConcurrent
  statusMaxConcurrent  Int?
  resultsMaxConcurrent Int?
}
```

---

## Adaptive throttling

`currentThrottle(workspaceId)` (`adaptive.service.ts`) returns a **throttle
multiplier** in `[minThrottle, 1]` computed from rolling API metrics over a
2-minute window (avg/p50/p95/p99 latency, error rate, timeout rate, and HTTP
401/404/429/500 counts pulled from `ApiRequestLog`).

- A workspace is **stressed** when (with ≥ 3 samples) `p95 ≥
  ADAPTIVE_LATENCY_MS`, **or** `errorRate ≥ ADAPTIVE_ERROR_RATE`, **or** any
  HTTP 429 appeared.
- On stress the multiplier is **halved** (down to `ADAPTIVE_MIN_THROTTLE`).
- After `ADAPTIVE_RECOVER_MS` with no further stress it **recovers gradually**
  (+0.1 per evaluation, never above 1).

The multiplier is applied in `TokenBucket.tryAcquire`: it scales **effective**
`maxRps`/`maxRpm` **down** and **inflates** `minDelayMs`
(`minDelay / throttle`). So under stress the same workspace is automatically
slowed, and it speeds back up as health returns. This works alongside the
per-workspace **circuit breaker** (see [`CIRCUIT_BREAKER.md`](./CIRCUIT_BREAKER.md)),
which hard-stops a workspace when failures cross a threshold.

---

## Environment variables

Rate limiting (`env.rate`, `src/config/env.ts`):

| Variable | Default | Meaning |
|---|---|---|
| `RATE_MAX_RPS` | `2` | Token refill rate (requests/second). |
| `RATE_MAX_RPM` | `60` | Requests per rolling minute. |
| `RATE_MAX_CONCURRENT` | `3` | Default per-workspace concurrent cap. |
| `RATE_MIN_DELAY_MS` | `200` | Minimum spacing between grants. |
| `RATE_BURST` | `5` | Token-bucket capacity. |
| `RATE_COOLDOWN_MS` | `30000` | Cooldown window (ms). |

Adaptive throttling (`env.adaptive`):

| Variable | Default | Meaning |
|---|---|---|
| `ADAPTIVE_ENABLED` | `true` | Master switch (off → throttle always 1). |
| `ADAPTIVE_LATENCY_MS` | `4000` | p95 latency (ms) that marks a workspace stressed. |
| `ADAPTIVE_ERROR_RATE` | `0.2` | Error-rate threshold for stress. |
| `ADAPTIVE_RECOVER_MS` | `60000` | Quiet period before recovery begins. |
| `ADAPTIVE_MIN_THROTTLE` | `0.25` | Floor of the throttle multiplier. |

Related global/concurrency setting (`env.sync`):

| Variable | Default | Meaning |
|---|---|---|
| `SYNC_GLOBAL_MAX_CONCURRENT` | `16` | Global ceiling on total `RUNNING` jobs. |

---

## How it all composes at claim time

`claimNext` (`queue.service.ts`) applies these gates, in order, before running a
job:

1. **Global concurrency** — stop if `RUNNING ≥ SYNC_GLOBAL_MAX_CONCURRENT`.
2. **Pause controls** — skip paused workspaces / job types.
3. **Fair ordering** — prefer workspaces with fewer `RUNNING` jobs.
4. **Circuit breaker** — skip if the workspace circuit is open.
5. **Per-workspace / per-endpoint concurrency** — skip if `RUNNING ≥ cap`.
6. **Atomic claim** — guarded `updateMany`.

Then, inside the handler, the **token-bucket gate** (`acquireSlot × throttle`)
enforces request pace; if no slot is available the job is rescheduled rather than
run.
