import { v4 as uuid } from 'uuid';
import { env } from '../../config/env';
import { prisma } from '../../db/prisma';
import { SYNC_ERROR, SyncErrorType } from '../../lib/enums';
import { logger } from '../../lib/logger';
import { ResolvedWorkspace } from '../workspace.service';
import { withLock } from '../sync/lock.service';
import { metrics } from '../observability/metrics.service';
import { fetchTransport } from './http';
import { getCachedToken, invalidateToken, setCachedToken } from './token-cache';
import { assertFastTestNotFrozen } from './freeze';
import { AuthResponse, HttpResponse, HttpTransport, StatusResponse } from './types';

export class FastTestApiError extends Error {
  constructor(
    public errorType: SyncErrorType,
    message: string,
    public httpStatus?: number,
    public fastTestErrorCode?: string,
    public fastTestErrorMessage?: string,
  ) {
    super(message);
    this.name = 'FastTestApiError';
  }
}

/** Map an HTTP response to a normalized sync error type. */
function classifyError(res: HttpResponse): SyncErrorType {
  if (res.timedOut) return SYNC_ERROR.TIMEOUT;
  if (res.networkError) return SYNC_ERROR.CONNECTION_FAILURE;
  switch (res.status) {
    case 401:
      return SYNC_ERROR.UNAUTHORIZED;
    case 403:
      return SYNC_ERROR.UNAUTHORIZED;
    case 404:
      return SYNC_ERROR.NOT_FOUND;
    case 429:
      return SYNC_ERROR.RATE_LIMITED;
    default:
      if (res.status >= 500) return SYNC_ERROR.SERVER_ERROR;
      return SYNC_ERROR.INVALID_RESPONSE;
  }
}

function extractFtError(body: any): { code?: string; message?: string } {
  if (!body || typeof body !== 'object') return {};
  return {
    code: body.errorCode ?? body.code ?? undefined,
    message: body.errorMessage ?? body.message ?? body.error ?? undefined,
  };
}

export interface FastTestClientOptions {
  transport?: HttpTransport;
  now?: () => number; // injectable clock for tests
}

export class FastTestClient {
  private transport: HttpTransport;
  private now: () => number;

  constructor(opts: FastTestClientOptions = {}) {
    this.transport = opts.transport ?? fetchTransport;
    this.now = opts.now ?? (() => Date.now());
  }

  private async logRequest(params: {
    workspaceId?: string;
    endpoint: string;
    method: string;
    requestedAt: Date;
    res: HttpResponse | null;
    responseTimeMs: number;
    correlationId: string;
    errorType?: SyncErrorType;
  }): Promise<void> {
    const ft = extractFtError(params.res?.body);
    metrics.requestsTotal.inc({ endpoint: params.endpoint, outcome: params.res?.ok ? 'success' : 'failure' });
    metrics.requestDuration.set(params.responseTimeMs, { endpoint: params.endpoint });
    if (!params.res?.ok) metrics.errorsTotal.inc({ endpoint: params.endpoint, code: String(params.res?.status ?? 0) });
    try {
      await prisma.apiRequestLog.create({
        data: {
          workspaceId: params.workspaceId ?? null,
          endpoint: params.endpoint,
          method: params.method,
          requestedAt: params.requestedAt,
          respondedAt: new Date(),
          responseTimeMs: params.responseTimeMs,
          httpStatus: params.res?.status ?? null,
          fastTestErrorCode: ft.code ?? params.errorType ?? null,
          fastTestErrorMessage: ft.message ?? null,
          success: !!params.res?.ok,
          correlationId: params.correlationId,
        },
      });
    } catch (e) {
      logger.warn({ err: (e as Error).message }, 'failed to persist api request log');
    }
  }

  /** Authenticate against POST /auth/simple and return the api token. */
  async authenticate(ws: ResolvedWorkspace, correlationId = uuid()): Promise<AuthResponse> {
    await assertFastTestNotFrozen();
    if (!ws.restApiKey) {
      throw new FastTestApiError(SYNC_ERROR.AUTH_FAILED, `Workspace ${ws.workspaceName} has no REST API key configured`);
    }
    const url = `${ws.baseUrl.replace(/\/$/, '')}/auth/simple`;
    const requestedAt = new Date();
    const start = this.now();
    const res = await this.transport({
      method: 'POST',
      url,
      body: {
        apiKey: ws.restApiKey,
        username: ws.username ?? '',
        pwd: ws.password ?? '',
        timeSent: Math.floor(this.now() / 1000),
        tokenTTL: ws.tokenTTL || env.fasttest.tokenTtlSeconds,
      },
      timeoutMs: env.fasttest.requestTimeoutMs,
    });
    const responseTimeMs = this.now() - start;
    await this.logRequest({
      workspaceId: ws.workspaceId,
      endpoint: '/auth/simple',
      method: 'POST',
      requestedAt,
      res,
      responseTimeMs,
      correlationId,
    });

    metrics.authTotal.inc({ workspace: ws.workspaceId, outcome: res.ok && res.body?.apiToken ? 'success' : 'failure' });

    if (!res.ok || !res.body?.apiToken) {
      const errorType = res.ok ? SYNC_ERROR.AUTH_FAILED : classifyError(res);
      const ft = extractFtError(res.body);
      await this.recordAuthStatus(ws.workspaceId, false, ft.message ?? `HTTP ${res.status}`, responseTimeMs);
      throw new FastTestApiError(errorType, `Authentication failed for ${ws.workspaceName}`, res.status, ft.code, ft.message);
    }

    const auth = res.body as AuthResponse;
    const ttl = auth.ttl ?? ws.tokenTTL ?? env.fasttest.tokenTtlSeconds;
    setCachedToken(ws.workspaceId, auth.apiToken, ttl, this.now());
    metrics.tokensRefreshed.inc({ workspace: ws.workspaceId });
    await this.recordAuthStatus(ws.workspaceId, true, null, responseTimeMs, ttl);
    return auth;
  }

  private async recordAuthStatus(workspaceId: string, ok: boolean, error: string | null, durationMs?: number, ttl?: number): Promise<void> {
    try {
      const marginSec = env.fasttest.tokenRefreshMarginSeconds;
      await prisma.fastTestWorkspace.update({
        where: { id: workspaceId },
        data: {
          lastAuthenticationAt: new Date(),
          lastAuthenticationStatus: ok ? 'SUCCESS' : 'FAILED',
          lastAuthenticationError: ok ? null : error,
          authenticationDurationMs: durationMs ?? undefined,
          authenticationFailureCount: ok ? 0 : { increment: 1 },
          nextTokenRefreshAt: ok && ttl ? new Date(this.now() + Math.max(0, ttl - marginSec) * 1000) : undefined,
        },
      });
    } catch {
      /* workspace may not exist in unit tests */
    }
  }

  /**
   * Return a valid cached token, authenticating if needed. Concurrent callers
   * in the same process share ONE authenticate (in-process single-flight), and
   * a cross-process distributed lock prevents token-refresh stampedes.
   */
  async getToken(ws: ResolvedWorkspace): Promise<string> {
    const cached = getCachedToken(ws.workspaceId, this.now());
    if (cached) return cached;

    const inflight = FastTestClient.refreshInFlight.get(ws.workspaceId);
    if (inflight) return inflight;

    const promise = this.refreshToken(ws).finally(() => FastTestClient.refreshInFlight.delete(ws.workspaceId));
    FastTestClient.refreshInFlight.set(ws.workspaceId, promise);
    return promise;
  }

  private static refreshInFlight = new Map<string, Promise<string>>();

  private async refreshToken(ws: ResolvedWorkspace): Promise<string> {
    // Cross-process guard: only one worker refreshes a workspace token at a time.
    const lockKey = `token:${ws.workspaceId}`;
    const owner = `client-${uuid().slice(0, 8)}`;
    const { acquired, result } = await withLock(lockKey, owner, 15000, async () => {
      const again = getCachedToken(ws.workspaceId, this.now());
      if (again) return again;
      const auth = await this.authenticate(ws);
      return auth.apiToken;
    });
    if (acquired && result) return result;
    // Another worker is refreshing — wait briefly then re-check / authenticate.
    await new Promise((r) => setTimeout(r, 250));
    const cached = getCachedToken(ws.workspaceId, this.now());
    if (cached) return cached;
    const auth = await this.authenticate(ws);
    return auth.apiToken;
  }

  private async authedGet(ws: ResolvedWorkspace, path: string, endpointLabel: string): Promise<any> {
    await assertFastTestNotFrozen();
    const correlationId = uuid();
    let token = await this.getToken(ws);
    const url = `${ws.baseUrl.replace(/\/$/, '')}${path}`;

    const doCall = async (): Promise<HttpResponse> => {
      const requestedAt = new Date();
      const start = this.now();
      const res = await this.transport({
        method: 'GET',
        url,
        headers: { api_token: token },
        timeoutMs: env.fasttest.requestTimeoutMs,
      });
      await this.logRequest({
        workspaceId: ws.workspaceId,
        endpoint: endpointLabel,
        method: 'GET',
        requestedAt,
        res,
        responseTimeMs: this.now() - start,
        correlationId,
      });
      return res;
    };

    let res = await doCall();

    // On 401 the token may have expired server-side; refresh once and retry.
    if (res.status === 401) {
      invalidateToken(ws.workspaceId);
      token = await this.getToken(ws);
      res = await doCall();
    }

    if (!res.ok) {
      const ft = extractFtError(res.body);
      throw new FastTestApiError(classifyError(res), `GET ${endpointLabel} failed`, res.status, ft.code, ft.message);
    }
    return res.body;
  }

  /** GET /tests/registration/{code}/status */
  async getStatus(ws: ResolvedWorkspace, testCodeNormalized: string): Promise<StatusResponse> {
    if (!testCodeNormalized) throw new FastTestApiError(SYNC_ERROR.INVALID_TESTCODE, 'Empty TestCode');
    const body = await this.authedGet(
      ws,
      `/tests/registration/${encodeURIComponent(testCodeNormalized)}/status`,
      '/tests/registration/{code}/status',
    );
    // FastTest returns the status as a single-element array; unwrap it.
    const status = Array.isArray(body) ? body[0] : body;
    if (!status) {
      throw new FastTestApiError(SYNC_ERROR.NOT_FOUND, `No FastTest registration found for ${testCodeNormalized}`);
    }
    return status as StatusResponse;
  }

  /** GET /tests/registration/{code}/results */
  async getResults(ws: ResolvedWorkspace, testCodeNormalized: string): Promise<any> {
    if (!testCodeNormalized) throw new FastTestApiError(SYNC_ERROR.INVALID_TESTCODE, 'Empty TestCode');
    return this.authedGet(
      ws,
      `/tests/registration/${encodeURIComponent(testCodeNormalized)}/results`,
      '/tests/registration/{code}/results',
    );
  }
}

export const fastTestClient = new FastTestClient();
