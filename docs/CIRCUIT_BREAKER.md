# Per-Workspace Circuit Breaker

The circuit breaker protects each FastTest workspace (and the platform as a
whole) from hammering an upstream that is failing, timing out, or rejecting
authentication. It is implemented **per workspace** and its state is
**persisted in the database** so that every worker process shares the same view.

- Implementation: `src/services/sync/circuit-breaker.service.ts`
- State model: `WorkspaceCircuitBreaker` (`prisma/schema.prisma`)
- States enum: `CIRCUIT_STATE` in `src/lib/enums.ts` (`CLOSED | OPEN | HALF_OPEN`)
- Thresholds: `env.circuit` in `src/config/env.ts`

---

## States

| State | Meaning | Requests allowed? |
|---|---|---|
| `CLOSED` | Healthy. Normal operation. | Yes — all requests pass. |
| `OPEN` | Tripped. Upstream considered unhealthy. | No — normal calls are blocked until `nextProbeAt`. |
| `HALF_OPEN` | Recovery probing. A limited number of trial requests are allowed. | Yes, but only as **probes** (`probe: true`). |

The decision function `canRequest(workspaceId)` returns
`{ allowed, state, probe }`. `probe` is `true` when the request is a HALF_OPEN
health probe.

---

## State diagram

```
                 failure threshold exceeded
                 (general / timeout / auth)
        ┌───────────────────────────────────────────┐
        │                                            ▼
   ┌─────────┐                                   ┌────────┐
   │ CLOSED  │                                   │  OPEN  │
   │         │                                   │        │
   │ failure │                                   │ blocks │
   │ count++ │                                   │ normal │
   └─────────┘                                   │ calls  │
        ▲                                        └────────┘
        │                                            │
        │ N probe successes                          │ now >= nextProbeAt
        │ (halfOpenProbes)                           │ (openMs elapsed)
        │                                            ▼
        │                                     ┌────────────┐
        └─────────────────────────────────── │ HALF_OPEN  │
                                              │  probe(s)  │
                                              └────────────┘
                                                    │
                                    probe failure   │
                                    re-opens circuit│
                                                    ▼
                                                 (OPEN)
```

- A **success** in `CLOSED` resets `failureCount` to 0.
- A **failure** in `CLOSED` increments `failureCount`; the circuit opens once a
  threshold is crossed (see below).
- After `openMs`, the next `canRequest` transitions `OPEN → HALF_OPEN` and
  allows a probe. Successful probes accumulate (`successCount`); once
  `halfOpenProbes` successes are reached the circuit **closes**. A single probe
  failure re-opens the circuit immediately.

---

## When it opens

`recordFailure(workspaceId, category)` decides whether to trip. From `CLOSED`,
the circuit opens if **any** of these thresholds is crossed by the running
`failureCount`:

| Trip condition | Error categories | Env threshold | Default |
|---|---|---|---|
| Repeated auth failures | `AUTHENTICATION`, `TOKEN_EXPIRED` | `CIRCUIT_AUTH_THRESHOLD` | `3` |
| Repeated timeouts | `TIMEOUT` | `CIRCUIT_TIMEOUT_THRESHOLD` | `3` |
| General failures | any category | `CIRCUIT_FAILURE_THRESHOLD` | `5` |

```ts
const authTrip    = AUTH_CATEGORIES.includes(category) && failureCount >= env.circuit.authFailThreshold;
const timeoutTrip = category === ERROR_CATEGORY.TIMEOUT   && failureCount >= env.circuit.timeoutThreshold;
const genTrip     = failureCount >= env.circuit.failureThreshold;
```

When it opens, the record is updated with `state = OPEN`, `openedAt = now`,
`nextProbeAt = now + openMs`, and a human-readable `lastTrippedReason`
(e.g. `threshold exceeded (TIMEOUT, 3 failures)`). A `circuit OPEN` warning is
logged.

A **probe failure while HALF_OPEN** re-opens the circuit immediately with the
reason `half-open probe failed (<category>)`, regardless of counts.

---

## What happens when OPEN

1. **Normal calls are blocked.** `canRequest` returns `allowed: false` while
   `now < nextProbeAt`.
2. **Jobs are gated at claim time.** The queue calls `canRequest` inside
   `claimNext` (`src/services/sync/queue.service.ts`). If the workspace circuit
   is not allowing the request, that candidate job is **skipped** (not claimed),
   so no worker executes work against a tripped workspace:

   ```ts
   // Circuit breaker gate (claimNext)
   const cb = await canRequest(cand.workspaceId, now);
   if (!cb.allowed) continue;
   ```

   Jobs are not failed — they simply remain queued until the circuit allows a
   probe, so recovery is automatic.
3. **Recovery via HALF_OPEN probe.** Once `now >= nextProbeAt`, the next
   `canRequest` flips the state to `HALF_OPEN`, resets `successCount`, and
   returns `allowed: true, probe: true`. A probe job is then claimable.
4. **Closes after N probe successes.** Each `recordSuccess` in `HALF_OPEN`
   increments `successCount`; when it reaches `env.circuit.halfOpenProbes`
   (default `2`) the circuit closes and all counters/timestamps reset.
5. **Re-opens on probe failure.** Any failure during `HALF_OPEN` calls
   `open(...)` again with a fresh `nextProbeAt = now + openMs`.

---

## Shared across workers

The breaker holds **no in-memory state** — every read and write goes through the
`WorkspaceCircuitBreaker` row (upserted on first use). This means:

- Any worker that trips a workspace instantly blocks **all** workers.
- Recovery probing is coordinated through the same row (`nextProbeAt`,
  `successCount`), so the fleet converges without leader election.

```prisma
model WorkspaceCircuitBreaker {
  workspaceId       String   @id
  state             String   @default("CLOSED") // CLOSED | OPEN | HALF_OPEN
  failureCount      Int      @default(0)
  successCount      Int      @default(0)
  openedAt          DateTime?
  nextProbeAt       DateTime?
  lastTrippedReason String?
  updatedAt         DateTime @updatedAt
  workspace FastTestWorkspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
}
```

---

## Where it is shown

| Surface | What is shown |
|---|---|
| **Queue Monitoring** (`/admin/queue`) | Per-workspace table includes each workspace's `circuitBreaker` (state + `lastTrippedReason`). Route loads `fastTestWorkspace.findMany({ include: { circuitBreaker: true } })`. |
| **Workspace health snapshots** | `captureSnapshots()` writes `circuitState` into each `WorkspaceHealthSnapshot`, so state is visible in the workspace-health history/trend. |
| **Alerts** (`/admin/alerts`) | `runAlertDetectors` raises a `CIRCUIT_OPENED` alert (HIGH) for every workspace whose breaker is `OPEN`, with `lastTrippedReason` as detail. |
| **Prometheus `/metrics`** | Gauge `workspace_circuit_state{workspace="…"}` — `0 = CLOSED`, `1 = HALF_OPEN`, `2 = OPEN`. |

---

## Interaction with adaptive throttling

Adaptive throttling (`src/services/sync/adaptive.service.ts`) is the **first line
of defense** and acts *before* the breaker trips. The two layers are graduated:

```
 healthy ───────────► degraded ───────────► failing
   │                     │                      │
   │  adaptive throttle  │  adaptive throttle   │  circuit breaker
   │  = 1.0 (full rps)   │  halves toward       │  OPENS
   │                     │  minThrottle (0.25)  │  (blocks entirely)
   ▼                     ▼                      ▼
 full speed          slowed down            stopped + probing
```

- `currentThrottle(workspaceId)` computes a multiplier in
  `[ADAPTIVE_MIN_THROTTLE, 1]` from a rolling 2-minute window of
  `ApiRequestLog` (p95 latency, error rate, presence of HTTP 429).
- Under stress the multiplier is **halved** (`* 0.5`, floored at
  `ADAPTIVE_MIN_THROTTLE`, default `0.25`); when healthy it recovers gradually
  (`+ 0.1` per evaluation after `ADAPTIVE_RECOVER_MS`).
- The rate limiter multiplies this throttle into effective `rps`/`rpm` and
  inflates `minDelayMs` (`tryAcquire(now, throttle)`), so the workspace is
  slowed down **before** enough hard failures accumulate to open the circuit.

The intent: adaptive throttling reduces throughput to relieve a stressed
upstream, giving it a chance to recover; only if failures still cross the trip
thresholds does the circuit breaker cut the workspace off entirely and enter the
probe-based recovery cycle.

---

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `CIRCUIT_FAILURE_THRESHOLD` | `5` | Consecutive failures (any category) that open the circuit. |
| `CIRCUIT_TIMEOUT_THRESHOLD` | `3` | Timeout failures that open the circuit. |
| `CIRCUIT_AUTH_THRESHOLD` | `3` | Auth/token-expired failures that open the circuit (also drives the `WORKSPACE_AUTH_FAILURE` alert). |
| `CIRCUIT_OPEN_MS` | `60000` | How long the circuit stays OPEN before allowing a HALF_OPEN probe. |
| `CIRCUIT_HALFOPEN_PROBES` | `2` | Consecutive probe successes required to close the circuit. |

Related adaptive knobs: `ADAPTIVE_ENABLED` (`true`), `ADAPTIVE_LATENCY_MS`
(`4000`), `ADAPTIVE_ERROR_RATE` (`0.2`), `ADAPTIVE_RECOVER_MS` (`60000`),
`ADAPTIVE_MIN_THROTTLE` (`0.25`).
