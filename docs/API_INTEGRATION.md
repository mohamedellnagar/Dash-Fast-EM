# FastTest API Integration

This document describes how the **FastTest Live Monitoring & Analytics Dashboard**
integrates with the FastTest REST API. All FastTest calls are **backend-only** —
the browser never talks to FastTest and never sees API keys or tokens.

The dashboard supports **multiple FastTest workspaces**, one per subject
(Arabic / English / Math / Science). Each workspace carries its own base URL and
its own REST API key (stored encrypted at rest). A workspace is resolved for a
given source subject by `src/services/workspace.service.ts`
(`resolveWorkspaceBySubject`), which returns a `ResolvedWorkspace` with decrypted
credentials for backend use.

Relevant source:

| File | Responsibility |
|---|---|
| `src/services/fasttest/client.ts` | `FastTestClient` — auth, token retrieval, GET status/results, request logging, error classification |
| `src/services/fasttest/token-cache.ts` | In-memory per-workspace token cache with refresh margin |
| `src/services/fasttest/http.ts` | Default `fetchTransport` (Node global `fetch` + timeout) |
| `src/services/fasttest/types.ts` | `HttpTransport`, `HttpRequest`, `HttpResponse`, `AuthResponse`, `StatusResponse` |
| `src/services/fasttest/results-mapper.ts` | `parseResults` — normalization + calculated fields |
| `src/lib/enums.ts` | Status map + `SYNC_ERROR` taxonomy + `PERMANENT_ERRORS` |

---

## Base URL configuration

Each workspace has its **own** `baseUrl` (from the DB, exposed on
`ResolvedWorkspace.baseUrl`). A process-wide default lives in `env.fasttest.baseUrl`:

```
FASTTEST_BASE_URL=https://uae.fasttestweb.com/FastTest/api   # default
```

All request URLs are built from the per-workspace base URL with any trailing
slash stripped:

```ts
const url = `${ws.baseUrl.replace(/\/$/, '')}/auth/simple`;
```

---

## Authentication

### Request — `POST /auth/simple`

`FastTestClient.authenticate(ws)` sends:

```jsonc
{
  "apiKey":   "<ws.restApiKey>",                 // per-workspace REST API key (decrypted)
  "username": "<ws.username ?? ''>",
  "pwd":      "<ws.password ?? ''>",
  "timeSent": 1752396600,                        // Math.floor(now / 1000) — unix seconds
  "tokenTTL": 3600                               // ws.tokenTTL || env.fasttest.tokenTtlSeconds
}
```

- `Content-Type: application/json`, `Accept: application/json`.
- Request times out after `env.fasttest.requestTimeoutMs` (default 15000 ms).
- If the workspace has **no** `restApiKey`, the call throws
  `FastTestApiError(AUTH_FAILED, ...)` before any HTTP request.

### Response

```jsonc
{
  "apiToken":      "<opaque token>",
  "timeGenerated": 1752396600,     // optional
  "workspaceName": "Arabic",       // optional
  "ttl":           3600            // optional; falls back to ws.tokenTTL then env default
}
```

Success requires `res.ok` **and** a non-empty `body.apiToken`. On success the
token is cached (see below) and the workspace row is updated with
`lastAuthenticationAt` / `lastAuthenticationStatus = SUCCESS`. On failure the
workspace records `lastAuthenticationStatus = FAILED` plus the error message, and
a `FastTestApiError` is thrown (`AUTH_FAILED` if the HTTP call itself was OK but no
token came back, otherwise the classified HTTP error).

---

## Token caching & refresh margin

Tokens are cached **in memory only**, per workspace id, in the backend process
(`src/services/fasttest/token-cache.ts`). They are never persisted and never sent
to clients.

- On `setCachedToken`, the absolute expiry is `now + ttlSeconds * 1000`.
- On `getCachedToken`, a token is treated as **expired early** by a refresh
  margin so callers refresh proactively:

```ts
const marginMs = env.fasttest.tokenRefreshMarginSeconds * 1000;
if (nowMs >= entry.expiresAtMs - marginMs) return null; // treat as expired
```

Config:

| Env var | Default | Meaning |
|---|---|---|
| `FASTTEST_TOKEN_TTL_SECONDS` | `3600` | Default token TTL when the auth response omits `ttl` and the workspace has none |
| `FASTTEST_TOKEN_REFRESH_MARGIN_SECONDS` | `300` | Refresh a cached token this many seconds **before** its true expiry |

`getToken(ws)` returns the cached token if valid; otherwise it authenticates and
caches a fresh one. `invalidateToken(workspaceId)` drops a single cache entry;
`clearAllTokens()` clears the whole cache. The client accepts an injectable
`now()` clock so tests can drive expiry deterministically.

---

## Status endpoint

`FastTestClient.getStatus(ws, testCodeNormalized)` →
`GET /tests/registration/{testCodeNormalized}/status`
(the test code is URL-encoded; an empty code throws `INVALID_TESTCODE`).

The endpoint label recorded in logs is the templated path
`'/tests/registration/{code}/status'`.

### Fields consumed (`StatusResponse` in `types.ts`)

| Field | Type |
|---|---|
| `status` | string (raw FastTest status) |
| `testId` | string |
| `testName` | string |
| `firstName` | string |
| `lastName` | string |
| `externalId` | string |
| `examineeId` | string |
| `registrationDate` | string |

Unknown fields are tolerated (`[k: string]: unknown`).

### Status mapping (`src/lib/enums.ts` → `toDashboardStatus`)

Raw status is normalized (trimmed, uppercased, separators stripped) then mapped:

| Raw FastTest status | Normalized dashboard status |
|---|---|
| `NEW` | `NOT_STARTED` |
| `INPROGRESS` | `IN_PROGRESS` |
| `COMPLETED` | `COMPLETED` |
| `INREVIEW` | `UNDER_REVIEW` |
| `FAILEDREVIEW` | `REVIEW_FAILED` |
| anything else / null / unknown | `UNKNOWN` |

(`toDashboardStatus` also accepts `IN_PROGRESS` as an alias for `IN_PROGRESS`.)

---

## Results endpoint

`FastTestClient.getResults(ws, testCodeNormalized)` →
`GET /tests/registration/{testCodeNormalized}/results`
(log label `'/tests/registration/{code}/results'`; empty code throws
`INVALID_TESTCODE`). The raw payload is passed to
`parseResults()` in `results-mapper.ts`.

`parseResults` reads the first element of `payload.examineeRegistrationResults`
as the primary result, and maps each entry in `primary.scores` via `parseScore`.

### Calculated / derived fields (`ParsedResult`)

| Field | Derivation |
|---|---|
| `attemptedItems` | `correct + incorrect` (sum across scores), or `undefined` if no item counts present |
| `totalItemsCount` | `correct + incorrect + skipped` (sum across scores), or `undefined` |
| `completionPercentage` | `round((attemptedItems / totalItemsCount) * 10000) / 100` (2-decimal %), only when `totalItemsCount > 0` |
| `durationFormatted` | `secondsUsed` formatted as `HH:MM:SS` (zero-padded); `undefined` when seconds are missing or negative |
| `startDate` | date portion split from `startTime` (`primary.startTime ?? primary.startDate`), accepts `YYYY-MM-DDTHH:MM:SS` or `YYYY-MM-DD HH:MM:SS` |
| `startTimeOnly` | time portion (`HH:MM` or `HH:MM:SS`) split from the same value |

Per-score fields (`ParsedScore`) include `rawScore`, `sumScore`, `cutScore`,
`scaledScore`, item counts `correct/incorrect/skipped`, totals
`totalCorrect/totalIncorrect/totalSkipped`, and the full raw score JSON. These are
the **scores persisted** alongside the parent result.

### Raw JSON persistence

The complete unmodified payloads are retained for diagnostics and
forward-compatibility:

- `ParsedResult.rawJson` = `JSON.stringify(payload)`
- `ParsedScore.rawJson` = `JSON.stringify(raw score object)`

---

## API data limitations (important)

The results endpoint payload is **not** assumed to contain the following, and the
mapper never fabricates them:

- `DateCompleted`, `TimeCompleted`, `Attempted`, `TestCode`, `Status` are **not**
  read from the results payload.
- `Attempted` is a **calculated** field only (`attemptedItems = correct + incorrect`).
  It is derived from score item counts, not taken from the API.
- Completion status comes from the **status endpoint** (mapped via
  `toDashboardStatus`), never inferred from results.
- Because assumptions are avoided, the **full raw JSON is persisted** so any field
  the API does return remains recoverable.

---

## Error taxonomy & HTTP classification

Errors surface as `FastTestApiError` carrying an `errorType: SyncErrorType`,
optional `httpStatus`, and optional FastTest `errorCode`/`errorMessage` (extracted
from the response body via `errorCode|code` and `errorMessage|message|error`).

### `SYNC_ERROR` types (`src/lib/enums.ts`)

`UNAUTHORIZED`, `TOKEN_EXPIRED`, `AUTH_FAILED`, `NOT_FOUND`, `SERVER_ERROR`,
`TIMEOUT`, `INVALID_TESTCODE`, `WORKSPACE_MISMATCH`, `RATE_LIMITED`,
`CONNECTION_FAILURE`, `INVALID_RESPONSE`.

### Permanent errors (never retried indefinitely)

```ts
PERMANENT_ERRORS = [NOT_FOUND, INVALID_TESTCODE, WORKSPACE_MISMATCH]
```

### HTTP → error classification (`classifyError`)

Checked in order:

| Condition | Error type |
|---|---|
| `timedOut` (AbortController fired) | `TIMEOUT` |
| `networkError` (fetch threw) | `CONNECTION_FAILURE` |
| HTTP `401` | `UNAUTHORIZED` |
| HTTP `403` | `UNAUTHORIZED` |
| HTTP `404` | `NOT_FOUND` |
| HTTP `429` | `RATE_LIMITED` |
| HTTP `>= 500` | `SERVER_ERROR` |
| any other non-OK status | `INVALID_RESPONSE` |

The `fetchTransport` maps a timeout to `{ status: 0, timedOut: true }` and any
other thrown error to `{ status: 0, networkError: true }`.

### 401 refresh-and-retry-once

On authenticated GETs, a `401` is treated as a possibly-expired server-side token:
the client invalidates the cached token, re-authenticates, and **retries the call
exactly once** (`src/services/fasttest/client.ts`, `authedGet`):

```ts
let res = await doCall();
if (res.status === 401) {
  invalidateToken(ws.workspaceId);
  token = await this.getToken(ws);   // re-authenticate
  res = await doCall();              // retry once
}
```

If the retry still fails, a `FastTestApiError` is thrown with the classified type.

---

## Request logging (`ApiRequestLog`)

Every FastTest HTTP call (auth, status, results — including the pre-retry call) is
persisted to `apiRequestLog` via `FastTestClient.logRequest`:

| Column | Value |
|---|---|
| `workspaceId` | workspace id (or null) |
| `endpoint` | templated label, e.g. `/auth/simple`, `/tests/registration/{code}/status` |
| `method` | `GET` / `POST` |
| `requestedAt` / `respondedAt` | timestamps |
| `responseTimeMs` | measured via the injectable clock |
| `httpStatus` | HTTP status or null |
| `fastTestErrorCode` | body error code, else the classified `errorType`, else null |
| `fastTestErrorMessage` | body error message, else null |
| `success` | `res.ok` |
| `correlationId` | UUID, shared across the retry attempts of one logical call |

**Secret redaction:** the log stores only endpoint labels, status, timing, and
FastTest error code/message. Request bodies (which contain `apiKey`, `pwd`) and
`Authorization` / `X-Api-Token` headers are **never** written to the log. Log
persistence failures are swallowed with a `logger.warn` so they never break a
sync. Application-level logging additionally redacts secret paths via Pino (see
`SECURITY.md`).

---

## Injectable transport & testing

The HTTP layer is abstracted behind `HttpTransport`
(`type HttpTransport = (req: HttpRequest) => Promise<HttpResponse>`) so tests can
inject a mock and **make no live network calls**:

```ts
const transport: HttpTransport = async (req) => ({
  status: 200, ok: true, body: { apiToken: 'tok', ttl: 3600 },
});
const client = new FastTestClient({ transport, now: () => 1_000_000 });
```

- `FastTestClient` defaults to the real `fetchTransport` but accepts
  `{ transport, now }` options.
- `now()` is an injectable clock used for TTL/expiry and response timing, enabling
  deterministic token-cache tests.
- Automated tests use the mock transport by default; **live tests against the real
  FastTest API are opt-in** and must not run in the normal automated suite.
