import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import { FastTestClient, FastTestApiError } from '../../src/services/fasttest/client';
import { clearAllTokens } from '../../src/services/fasttest/token-cache';
import { HttpRequest, HttpResponse } from '../../src/services/fasttest/types';
import { ResolvedWorkspace } from '../../src/services/workspace.service';
import { SYNC_ERROR } from '../../src/lib/enums';
import { prisma } from '../../src/db/prisma';

// Ensure the workspace referenced by the client exists so the (best-effort)
// ApiRequestLog writes satisfy the foreign key instead of being swallowed.
beforeAll(async () => {
  await prisma.fastTestWorkspace.upsert({
    where: { id: 'test-ws-fixed' },
    create: { id: 'test-ws-fixed', workspaceName: 'Test WS', subjectCode: 'ARABIC', baseUrl: 'https://example.test/api' },
    update: {},
  });
});

const ws: ResolvedWorkspace = {
  workspaceId: 'test-ws-fixed',
  workspaceName: 'Test WS',
  subjectCode: 'ARABIC',
  baseUrl: 'https://example.test/api',
  restApiKey: 'key-123',
  username: '',
  password: '',
  tokenTTL: 3600,
};

// Builds a scripted transport from a list of responses (by call order).
function scripted(responses: HttpResponse[]) {
  const calls: HttpRequest[] = [];
  let i = 0;
  const transport = async (req: HttpRequest): Promise<HttpResponse> => {
    calls.push(req);
    return responses[Math.min(i++, responses.length - 1)];
  };
  return { transport, calls };
}

const authOk: HttpResponse = { status: 200, ok: true, body: { apiToken: 'TOK-1', ttl: 3600, workspaceName: 'Test WS' } };

describe('FastTestClient (mock transport — no live calls)', () => {
  beforeEach(() => clearAllTokens());

  it('authenticates and caches the token', async () => {
    let now = 1_000_000_000;
    const { transport, calls } = scripted([authOk]);
    const client = new FastTestClient({ transport, now: () => now });
    const auth = await client.authenticate(ws);
    expect(auth.apiToken).toBe('TOK-1');
    expect(calls[0].url).toContain('/auth/simple');
    expect(calls[0].body).toMatchObject({ apiKey: 'key-123', tokenTTL: 3600 });
    // Second getToken should NOT re-authenticate (cached).
    const t = await client.getToken(ws);
    expect(t).toBe('TOK-1');
    expect(calls.length).toBe(1);
  });

  it('sends the token and returns status', async () => {
    const statusResp: HttpResponse = { status: 200, ok: true, body: { status: 'INPROGRESS', testId: 42, firstName: 'A' } };
    const { transport, calls } = scripted([authOk, statusResp]);
    const client = new FastTestClient({ transport, now: () => 1_000_000_000 });
    const s = await client.getStatus(ws, 'FUJ290263565');
    expect(s.status).toBe('INPROGRESS');
    expect(calls[1].url).toContain('/tests/registration/FUJ290263565/status');
    expect(calls[1].headers?.api_token).toBe('TOK-1');
  });

  it('refreshes token and retries once on 401', async () => {
    const unauthorized: HttpResponse = { status: 401, ok: false, body: { message: 'expired' } };
    const authOk2: HttpResponse = { status: 200, ok: true, body: { apiToken: 'TOK-2', ttl: 3600 } };
    const okStatus: HttpResponse = { status: 200, ok: true, body: { status: 'COMPLETED' } };
    // auth, status(401), auth(refresh), status(ok)
    const { transport, calls } = scripted([authOk, unauthorized, authOk2, okStatus]);
    const client = new FastTestClient({ transport, now: () => 1_000_000_000 });
    const s = await client.getStatus(ws, 'ABC123');
    expect(s.status).toBe('COMPLETED');
    expect(calls.length).toBe(4);
    expect(calls[3].headers?.api_token).toBe('TOK-2');
  });

  it('classifies 404 as NOT_FOUND', async () => {
    const notFound: HttpResponse = { status: 404, ok: false, body: { errorCode: 'E404', message: 'no such test' } };
    const { transport } = scripted([authOk, notFound]);
    const client = new FastTestClient({ transport, now: () => 1_000_000_000 });
    await expect(client.getStatus(ws, 'MISSING')).rejects.toMatchObject({ errorType: SYNC_ERROR.NOT_FOUND });
  });

  it('classifies a timeout', async () => {
    const timeout: HttpResponse = { status: 0, ok: false, body: null, timedOut: true };
    const { transport } = scripted([authOk, timeout]);
    const client = new FastTestClient({ transport, now: () => 1_000_000_000 });
    await expect(client.getStatus(ws, 'X')).rejects.toMatchObject({ errorType: SYNC_ERROR.TIMEOUT });
  });

  it('fails auth cleanly when API key is missing', async () => {
    const { transport } = scripted([authOk]);
    const client = new FastTestClient({ transport, now: () => 1_000_000_000 });
    await expect(client.authenticate({ ...ws, restApiKey: null })).rejects.toBeInstanceOf(FastTestApiError);
  });
});
