# Load Testing Guide

Load testing guide for the **FastTest Live Monitoring & Analytics Dashboard**.

> **Load testing is DISABLED by default and gated behind explicit safety flags.** Read the safety section before running anything.

---

## Safety posture (read first)

Load testing can generate heavy traffic against the FastTest API. Multiple guards make it impossible to run by accident:

1. **App-level flag is off by default.** `src/config/env.ts` exposes `loadTestEnabled`, sourced from `LOAD_TEST_ENABLED` and defaulting to **`false`**. Leave it `false` in production.
2. **The k6 script refuses to run without an authorization token.** `scripts/load-test/k6-status.js` throws immediately unless:
   ```
   LOAD_TEST_CONFIRM=I_HAVE_AUTHORIZATION
   ```
   Any other value (or unset) aborts with:
   *"Refusing to run: set LOAD_TEST_CONFIRM=I_HAVE_AUTHORIZATION and ensure you have written authorization."*
3. **Required inputs are validated.** The script also aborts unless `BASE_URL`, `API_TOKEN`, and at least one `TEST_CODES` entry are provided.

**Rules:**

- **Never run uncontrolled load against production FastTest.**
- **Obtain written authorization** before any high-volume run; prefer a **staging** endpoint.
- Setting `LOAD_TEST_CONFIRM=I_HAVE_AUTHORIZATION` is an explicit attestation that you have that authorization.

---

## Controlled tiers

Runs are sized into controlled tiers by picking the k6 iteration count (`ITER`) and virtual users (`VUS`) to match:

| Tier | Test codes / iterations |
|------|-------------------------|
| Tier 1 | 10 |
| Tier 2 | 50 |
| Tier 3 | 100 |
| Tier 4 | 500 |
| Tier 5 | 1000 |

Start at the smallest tier and only step up after reviewing results and confirming the target can absorb the next tier.

---

## Running `scripts/load-test/k6-status.js`

The script drives the FastTest **status** endpoint: `GET {BASE_URL}/tests/registration/{code}/status` with a `Bearer` token. It uses k6's `shared-iterations` executor (`vus: VUS`, `iterations: ITER`, `maxDuration: 10m`) and randomly picks a code from `TEST_CODES` on each iteration.

### Environment variables

| Var | Required | Default | Purpose |
|-----|----------|---------|---------|
| `LOAD_TEST_CONFIRM` | **yes** | — | Must equal `I_HAVE_AUTHORIZATION` or the script refuses to run |
| `BASE_URL` | **yes** | — | FastTest API root (e.g. `https://staging.example/FastTest/api`) |
| `API_TOKEN` | **yes** | — | Bearer token sent as `Authorization: Bearer <token>` |
| `TEST_CODES` | **yes** | — | Comma-separated test codes (e.g. `FUJ290263565,ABU111222333`) |
| `VUS` | no | `10` | Concurrent virtual users |
| `ITER` | no | `100` | Total iterations (choose to match a tier) |

### Example command

```bash
LOAD_TEST_CONFIRM=I_HAVE_AUTHORIZATION \
BASE_URL=https://staging.example/FastTest/api \
API_TOKEN=eyJhbGci... \
TEST_CODES=FUJ290263565,ABU111222333 \
k6 run -e VUS=10 -e ITER=100 scripts/load-test/k6-status.js
```

(Requires the [k6](https://k6.io) load-testing tool installed locally.)

---

## Metrics captured

The script records total/success/failed requests plus response-time distribution and error breakdowns:

- **Requests:** total, success, failed
- **Response time:** avg, median, p95, p99, min, max (via the `resp_ms` Trend and k6's built-in `http_req_duration`)
- **Throughput:** requests per second (RPS)
- **Timeouts:** counted via the `timeouts` counter (k6 error code `1050`; per-request `timeout: 15s`)
- **HTTP status buckets:** `status_401`, `status_404`, `status_500` (5xx) counters

---

## Thresholds

k6 fails the run if either threshold is breached:

| Metric | Threshold |
|--------|-----------|
| `http_req_duration` p95 | **< 3000 ms** |
| `http_req_failed` rate | **< 5% (0.05)** |

The success check per iteration asserts the response status is **2xx**.

---

## Interpreting results

- **p95 / p99 latency** — watch p95 against the 3000 ms threshold; a rising p99 signals tail latency under contention.
- **Failure rate** — must stay under 5%. If it climbs, inspect the status counters to see *why*.
- **`status_401`** — token expiry / auth issues; refresh `API_TOKEN`.
- **`status_404`** — unknown/invalid test codes in `TEST_CODES`.
- **`status_500`** — server-side errors on the target; back off and reduce the tier.
- **`timeouts`** — requests exceeding the 15s per-request timeout; indicates the target is saturated — drop to a lower tier.
- **RPS** — effective throughput; compare across tiers to find where latency/error rates degrade.

If thresholds fail or errors spike, **stop and step down a tier**.

---

## Note on a fuller in-app load module

`scripts/load-test/k6-status.js` is a standalone k6 harness for the status endpoint. A fuller, in-application load-testing module (surfacing the controlled tiers and metrics inside the app itself) is a **Phase 5 deliverable** and is not part of the current build. The `LOAD_TEST_ENABLED` flag in `src/config/env.ts` is the safety switch that module will honor.
