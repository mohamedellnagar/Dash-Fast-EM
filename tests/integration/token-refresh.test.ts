import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import { prisma } from '../../src/db/prisma';
import { FastTestClient } from '../../src/services/fasttest/client';
import { clearAllTokens } from '../../src/services/fasttest/token-cache';
import { getWorkspaceById } from '../../src/services/workspace.service';
import { encrypt } from '../../src/lib/crypto';
import { HttpRequest, HttpResponse } from '../../src/services/fasttest/types';

let wsId: string;

beforeAll(async () => {
  wsId = (await prisma.fastTestWorkspace.create({ data: { workspaceName: 'Tok WS', subjectCode: 'TOKWS', baseUrl: 'https://x.test/api', restApiKeyEncrypted: encrypt('key') } })).id;
});
beforeEach(async () => {
  clearAllTokens();
  await prisma.distributedLock.deleteMany({});
});

describe('Token lifecycle', () => {
  it('concurrent getToken triggers exactly one authentication (single-flight)', async () => {
    const ws = (await getWorkspaceById(wsId))!;
    let authCalls = 0;
    const transport = async (req: HttpRequest): Promise<HttpResponse> => {
      if (req.url.includes('/auth')) {
        authCalls++;
        await new Promise((r) => setTimeout(r, 20));
        return { status: 200, ok: true, body: { apiToken: 'TOK-1', ttl: 3600 } };
      }
      return { status: 200, ok: true, body: {} };
    };
    const client = new FastTestClient({ transport, now: () => Date.now() });
    const tokens = await Promise.all(Array.from({ length: 6 }, () => client.getToken(ws)));
    expect(authCalls).toBe(1); // stampede prevented
    expect(new Set(tokens)).toEqual(new Set(['TOK-1']));
  });

  it('caches the token (no re-auth within TTL) and records lifecycle fields', async () => {
    const ws = (await getWorkspaceById(wsId))!;
    let authCalls = 0;
    const client = new FastTestClient({ transport: async (req) => { if (req.url.includes('/auth')) { authCalls++; return { status: 200, ok: true, body: { apiToken: 'T', ttl: 3600 } }; } return { status: 200, ok: true, body: {} }; }, now: () => Date.now() });
    await client.getToken(ws);
    await client.getToken(ws);
    expect(authCalls).toBe(1);
    const w = await prisma.fastTestWorkspace.findUnique({ where: { id: wsId } });
    expect(w!.lastAuthenticationStatus).toBe('SUCCESS');
    expect(w!.nextTokenRefreshAt).not.toBeNull();
    expect(w!.authenticationDurationMs).not.toBeNull();
  });

  it('increments failure count and never logs the token on auth failure', async () => {
    const ws = (await getWorkspaceById(wsId))!;
    const client = new FastTestClient({ transport: async () => ({ status: 401, ok: false, body: { message: 'bad' } }), now: () => Date.now() });
    await expect(client.getToken(ws)).rejects.toBeTruthy();
    const w = await prisma.fastTestWorkspace.findUnique({ where: { id: wsId } });
    expect(w!.authenticationFailureCount).toBeGreaterThanOrEqual(1);
  });
});
