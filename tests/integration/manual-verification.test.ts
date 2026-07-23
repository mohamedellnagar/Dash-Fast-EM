import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app';
import { prisma } from '../../src/db/prisma';
import { hashPassword } from '../../src/services/auth.service';
import { ROLE, PERMISSION, SYNC_ERROR } from '../../src/lib/enums';
import { makeSchool, makeRegistration, clearRegistrations } from '../helpers/fixtures';
import { FastTestClient } from '../../src/services/fasttest/client';
import { clearAllTokens } from '../../src/services/fasttest/token-cache';
import { HttpRequest, HttpResponse } from '../../src/services/fasttest/types';
import { verifyTestCode, explainFailure, recentChecks } from '../../src/services/manual-verification.service';
import { normalizeTestCode } from '../../src/lib/testcode';
import { encrypt } from '../../src/lib/crypto';

const app = createApp();
const WS_ID = '11111111-1111-4111-8111-111111111111';
const CODE_PLAIN = 'MAK-665-486-329';
const CODE_NORM = 'MAK665486329';

const authOk: HttpResponse = { status: 200, ok: true, body: { apiToken: 'TOK-MV', ttl: 3600 } };
const statusBody = [{
  status: 'COMPLETED', testId: 'T-9', testName: 'Arabic Grade 5',
  firstName: 'Sara', lastName: 'Ahmed', externalId: 'EID-MV-1',
  examineeId: 'EX-77', registrationDate: '2026-07-01',
  // A field this dashboard does not know about — it must survive to the client.
  unexpectedNewField: 'keep-me',
}];
const resultsBody = {
  firstName: 'Sara', lastName: 'Ahmed', externalId: 'EID-MV-1', examineeId: 'EX-77',
  email: 'sara@example.test', registrationDate: '2026-07-01',
  examineeRegistrationResults: [{
    // Naive 12-hour string exactly as FastTest sends it: no AM/PM, no offset.
    testName: 'Arabic Grade 5', startTime: '2026-07-01 08:00:00', secondsUsed: 278,
    passed: true, testSessionId: 'S-1', testSessionName: 'Session 1',
    // Real FastTest shape: item counts are nested under scoredItems/totalItems.
    scores: [{
      name: 'Overall', subscore: 'TOTAL', rawScore: 32, scaledScore: 88, sumScore: 32, cutScore: 20,
      scoredItems: { correct: 30, incorrect: 2, skipped: 4 },
      totalItems: { correct: 30, incorrect: 2, skipped: 4 },
    }],
  }],
};

/** Scripted transport keyed by URL suffix, so call order does not matter. */
function routed(map: Record<string, HttpResponse>) {
  const calls: HttpRequest[] = [];
  const transport = async (req: HttpRequest): Promise<HttpResponse> => {
    calls.push(req);
    if (req.url.endsWith('/auth/simple')) return map.auth ?? authOk;
    if (req.url.endsWith('/status')) return map.status ?? { status: 404, ok: false, body: null };
    if (req.url.endsWith('/results')) return map.results ?? { status: 404, ok: false, body: null };
    return { status: 500, ok: false, body: null };
  };
  return { transport, calls };
}
function clientFor(map: Record<string, HttpResponse>) {
  const { transport, calls } = routed(map);
  return { client: new FastTestClient({ transport }), calls };
}

async function makeUser(email: string, pw: string, roleKey: string) {
  const role = await prisma.role.findUnique({ where: { key: roleKey } });
  const u = await prisma.user.create({ data: { email, passwordHash: await hashPassword(pw), fullName: email } });
  if (role) await prisma.userRole.create({ data: { userId: u.id, roleId: role.id } });
  return u;
}
async function agentFor(email: string, pw: string) {
  const agent = request.agent(app);
  await agent.post('/login').type('form').send({ email, password: pw });
  return agent;
}

const ADMIN_PW = 'MvAdmin!123';
const VIEWER_PW = 'MvViewer!123';
let adminEmail: string;
let viewerEmail: string;

beforeAll(async () => {
  await clearRegistrations();
  await prisma.fastTestWorkspace.upsert({
    where: { id: WS_ID },
    create: {
      id: WS_ID, workspaceName: 'Arabic WS', subjectCode: 'ARABIC',
      baseUrl: 'https://ft.example.test/api', isActive: true,
      // Credentials are required for the client to attempt auth at all; they are
      // encrypted at rest exactly as in production and never leave the server.
      restApiKeyEncrypted: encrypt('test-rest-api-key'),
      usernameEncrypted: encrypt('test-user'),
      passwordEncrypted: encrypt('test-pass'),
    },
    update: {
      isActive: true, deletedAt: null,
      restApiKeyEncrypted: encrypt('test-rest-api-key'),
      usernameEncrypted: encrypt('test-user'),
      passwordEncrypted: encrypt('test-pass'),
    },
  });

  const school = await makeSchool('MV School');
  const student = await prisma.student.create({
    data: { externalId: 'STU-MV-1', nameEnglish: 'Sara Ahmed', nameArabic: 'سارة أحمد', emiratesId: 'EID-MV-1' },
  });
  await makeRegistration({
    schoolId: school.id, studentId: student.id, studentExternalId: 'STU-MV-1',
    emiratesId: 'EID-MV-1', examSubject: 'Arabic Reading', grade: '5',
    testCode: CODE_PLAIN, status: 'COMPLETED', workspaceId: WS_ID,
  });
  // Sensitive local values that must be masked by default.
  await prisma.examRegistration.updateMany({
    where: { testCodeNormalized: CODE_NORM },
    data: {
      accessToken: 'ACCESS-TOKEN-SECRET-VALUE', proctorCode: 'PROCTOR-SECRET-1', examName: 'Arabic Grade 5',
      // The scheduled daily window — what recovers FastTest's missing AM/PM.
      startTime: '7:30:00', endTime: '15:30:00',
    },
  });

  adminEmail = `mv-admin-${Date.now()}@t.local`;
  viewerEmail = `mv-viewer-${Date.now()}@t.local`;
  await makeUser(adminEmail, ADMIN_PW, ROLE.ADMINISTRATOR);
  await makeUser(viewerEmail, VIEWER_PW, ROLE.VIEWER);
});

beforeEach(() => clearAllTokens());

// ---------------------------------------------------------------------------
describe('Test Code normalization', () => {
  it('strips hyphens and spaces and upper-cases', () => {
    expect(normalizeTestCode('MAK-665-486-329')).toBe(CODE_NORM);
    expect(normalizeTestCode('  mak 665 486 329 ')).toBe(CODE_NORM);
    expect(normalizeTestCode('mak-665-486-329')).toBe(CODE_NORM);
  });

  it('rejects an empty code before any API call', async () => {
    const { client, calls } = clientFor({});
    const r = await verifyTestCode({ testCode: '   ' }, client);
    expect(r.normalizedTestCode).toBe('');
    expect(r.error).toBeTruthy();
    expect(calls).toHaveLength(0); // never contacts FastTest
  });

  it('keeps both the original and the normalized form', async () => {
    const { client } = clientFor({ status: { status: 200, ok: true, body: statusBody } });
    const r = await verifyTestCode({ testCode: ' mak-665-486-329 ' }, client);
    expect(r.originalTestCode).toBe('mak-665-486-329');
    expect(r.normalizedTestCode).toBe(CODE_NORM);
  });

  it('sends the normalized code (no hyphens) in the request URL', async () => {
    const { client, calls } = clientFor({ status: { status: 200, ok: true, body: statusBody } });
    await verifyTestCode({ testCode: CODE_PLAIN }, client);
    const urls = calls.map((c) => c.url).filter((u) => u.includes('/registration/'));
    expect(urls.length).toBeGreaterThan(0);
    for (const u of urls) {
      expect(u).toContain(CODE_NORM);
      expect(u).not.toContain('MAK-665');
    }
  });
});

// ---------------------------------------------------------------------------
describe('Workspace resolution', () => {
  it('uses the workspace assigned to the local registration', async () => {
    const { client } = clientFor({ status: { status: 200, ok: true, body: statusBody } });
    const r = await verifyTestCode({ testCode: CODE_PLAIN }, client);
    expect(r.workspace?.id).toBe(WS_ID);
    expect(r.workspace?.resolvedBy).toBe('local registration');
  });

  it('cannot resolve a workspace for an unknown code and says so', async () => {
    const { client, calls } = clientFor({});
    const r = await verifyTestCode({ testCode: 'ZZZ-000-000-000' }, client);
    expect(r.workspace).toBeNull();
    expect(r.workspaceError).toMatch(/not in the local database/i);
    expect(calls).toHaveLength(0); // no blind credential probing across workspaces
  });

  it('honours an explicit workspace override', async () => {
    const { client } = clientFor({ status: { status: 200, ok: true, body: statusBody } });
    const r = await verifyTestCode({ testCode: 'ZZZ-000-000-000', workspaceId: WS_ID }, client);
    expect(r.workspace?.id).toBe(WS_ID);
    expect(r.workspace?.resolvedBy).toBe('manual override');
  });
});

// ---------------------------------------------------------------------------
describe('Token handling', () => {
  it('authenticates once and reuses the cached token for both lookups', async () => {
    const { client, calls } = clientFor({
      status: { status: 200, ok: true, body: statusBody },
      results: { status: 200, ok: true, body: resultsBody },
    });
    await verifyTestCode({ testCode: CODE_PLAIN }, client);
    expect(calls.filter((c) => c.url.endsWith('/auth/simple'))).toHaveLength(1);
    expect(calls.filter((c) => c.url.includes('/registration/'))).toHaveLength(2);
  });

  it('refreshes the token and retries once when FastTest returns 401', async () => {
    const calls: HttpRequest[] = [];
    let statusCall = 0;
    const transport = async (req: HttpRequest): Promise<HttpResponse> => {
      calls.push(req);
      if (req.url.endsWith('/auth/simple')) return authOk;
      if (req.url.endsWith('/status')) {
        statusCall += 1;
        return statusCall === 1
          ? { status: 401, ok: false, body: { errorMessage: 'token expired' } }
          : { status: 200, ok: true, body: statusBody };
      }
      return { status: 404, ok: false, body: null };
    };
    const r = await verifyTestCode({ testCode: CODE_PLAIN }, new FastTestClient({ transport }));
    expect(r.fastTest.status.success).toBe(true);
    expect(statusCall).toBe(2); // retried after refresh
    expect(calls.filter((c) => c.url.endsWith('/auth/simple')).length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
describe('Lookup outcomes', () => {
  it('returns both status and results when both succeed', async () => {
    const { client } = clientFor({
      status: { status: 200, ok: true, body: statusBody },
      results: { status: 200, ok: true, body: resultsBody },
    });
    const r = await verifyTestCode({ testCode: CODE_PLAIN }, client);
    expect(r.fastTest.status.success).toBe(true);
    expect(r.fastTest.results.success).toBe(true);
    expect((r.fastTest.status.data as any).testName).toBe('Arabic Grade 5');
    expect(r.fastTest.status.latencyMs).not.toBeNull();
    expect(r.fastTest.status.httpCode).toBe(200);
  });

  it('still shows status data when results 404s', async () => {
    const { client } = clientFor({
      status: { status: 200, ok: true, body: statusBody },
      results: { status: 404, ok: false, body: { errorMessage: 'no results yet' } },
    });
    const r = await verifyTestCode({ testCode: CODE_PLAIN }, client);
    expect(r.fastTest.status.success).toBe(true);
    expect((r.fastTest.status.data as any).status).toBe('COMPLETED');
    expect(r.fastTest.results.success).toBe(false);
    expect(r.fastTest.results.httpCode).toBe(404);
    expect(r.success).toBe(true); // one failure does not sink the whole check
    expect(explainFailure(r.fastTest.results.errorType, 404)).toMatch(/no data at this endpoint/i);
  });

  it('shows results and warns when the local record is missing', async () => {
    const { client } = clientFor({
      status: { status: 200, ok: true, body: statusBody },
      results: { status: 200, ok: true, body: resultsBody },
    });
    const r = await verifyTestCode({ testCode: 'QQQ-111-222-333', workspaceId: WS_ID }, client);
    expect(r.localRecordFound).toBe(false);
    expect(r.localRecord).toBeNull();
    expect(r.fastTest.results.success).toBe(true);
    const existence = r.comparisons.find((c) => c.key === 'existence')!;
    expect(existence.verdict).toBe('WARNING');
    expect(existence.note).toMatch(/never imported/i);
  });

  it('does not discard unknown fields returned by the API', async () => {
    const { client } = clientFor({ status: { status: 200, ok: true, body: statusBody } });
    const r = await verifyTestCode({ testCode: CODE_PLAIN }, client);
    expect((r.fastTest.status.data as any).unexpectedNewField).toBe('keep-me');
  });

  it('survives a malformed results payload without losing the status data', async () => {
    const { client } = clientFor({
      status: { status: 200, ok: true, body: statusBody },
      results: { status: 200, ok: true, body: 'not-json-shaped' },
    });
    const r = await verifyTestCode({ testCode: CODE_PLAIN }, client);
    expect(r.fastTest.status.success).toBe(true);
    expect(r.fastTest.results.success).toBe(true); // HTTP succeeded
    expect(r.calculated).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
describe('HTTP error mapping', () => {
  const cases: Array<[number, string, RegExp]> = [
    [401, SYNC_ERROR.UNAUTHORIZED, /rejected the token/i],
    [403, SYNC_ERROR.UNAUTHORIZED, /not permitted/i],
    [404, SYNC_ERROR.NOT_FOUND, /no data at this endpoint/i],
    [429, SYNC_ERROR.RATE_LIMITED, /rate-limiting/i],
    [500, SYNC_ERROR.SERVER_ERROR, /server error/i],
  ];

  for (const [code, expectedType, explainRe] of cases) {
    it(`maps HTTP ${code} to ${expectedType} with an explanation`, async () => {
      // 401 is retried once by design, so always fail it to reach the mapping.
      const { client } = clientFor({
        status: { status: code, ok: false, body: { errorMessage: `boom ${code}` } },
        results: { status: code, ok: false, body: null },
      });
      const r = await verifyTestCode({ testCode: CODE_PLAIN }, client);
      expect(r.fastTest.status.success).toBe(false);
      expect(r.fastTest.status.errorType).toBe(expectedType);
      expect(r.fastTest.status.httpCode).toBe(code);
      expect(explainFailure(expectedType, code)).toMatch(explainRe);
    });
  }

  it('maps a timeout', async () => {
    const transport = async (req: HttpRequest): Promise<HttpResponse> =>
      req.url.endsWith('/auth/simple') ? authOk : { status: 0, ok: false, body: null, timedOut: true };
    const r = await verifyTestCode({ testCode: CODE_PLAIN }, new FastTestClient({ transport }));
    expect(r.fastTest.status.errorType).toBe(SYNC_ERROR.TIMEOUT);
    expect(explainFailure(SYNC_ERROR.TIMEOUT, null)).toMatch(/did not respond/i);
  });

  it('maps a network/TLS failure', async () => {
    const transport = async (req: HttpRequest): Promise<HttpResponse> =>
      req.url.endsWith('/auth/simple') ? authOk : { status: 0, ok: false, body: null, networkError: true };
    const r = await verifyTestCode({ testCode: CODE_PLAIN }, new FastTestClient({ transport }));
    expect(r.fastTest.status.errorType).toBe(SYNC_ERROR.CONNECTION_FAILURE);
  });

  it('reports an authentication failure without throwing', async () => {
    const { client } = clientFor({ auth: { status: 401, ok: false, body: { errorMessage: 'bad key' } } });
    const r = await verifyTestCode({ testCode: CODE_PLAIN }, client);
    expect(r.fastTest.status.success).toBe(false);
    expect(r.fastTest.results.success).toBe(false);
    expect(r.localRecordFound).toBe(true); // local data still shown
  });
});

// ---------------------------------------------------------------------------
describe('Calculated values and comparisons', () => {
  it('computes attempted, total items, completion % and HH:MM:SS duration', async () => {
    const { client } = clientFor({
      status: { status: 200, ok: true, body: statusBody },
      results: { status: 200, ok: true, body: resultsBody },
    });
    const r = await verifyTestCode({ testCode: CODE_PLAIN }, client);
    const c = r.calculated!;
    expect(c.attempted).toBe(32);        // 30 correct + 2 incorrect
    expect(c.totalItems).toBe(36);       // + 4 skipped
    expect(c.completionPercentage).toBe(88.89);
    expect(c.formattedDuration).toBe('00:04:38'); // 278s
  });

  it('matches externalId against the local Emirates ID', async () => {
    const { client } = clientFor({ status: { status: 200, ok: true, body: statusBody } });
    const r = await verifyTestCode({ testCode: CODE_PLAIN }, client);
    expect(r.comparisons.find((c) => c.key === 'externalId')?.verdict).toBe('MATCH');
  });

  it('flags a mismatched externalId', async () => {
    const { client } = clientFor({
      status: { status: 200, ok: true, body: [{ ...statusBody[0], externalId: 'SOMEONE-ELSE' }] },
    });
    const r = await verifyTestCode({ testCode: CODE_PLAIN }, client);
    expect(r.comparisons.find((c) => c.key === 'externalId')?.verdict).toBe('MISMATCH');
  });

  it('reports NOT_ENOUGH_DATA rather than guessing when a side is absent', async () => {
    const { client } = clientFor({ status: { status: 404, ok: false, body: null } });
    const r = await verifyTestCode({ testCode: CODE_PLAIN }, client);
    expect(r.comparisons.find((c) => c.key === 'status')?.verdict).toBe('NOT_ENOUGH_DATA');
  });

  it('flags a code that exists locally but not in FastTest', async () => {
    const { client } = clientFor({
      status: { status: 404, ok: false, body: null },
      results: { status: 404, ok: false, body: null },
    });
    const r = await verifyTestCode({ testCode: CODE_PLAIN }, client);
    const existence = r.comparisons.find((c) => c.key === 'existence')!;
    expect(existence.verdict).toBe('WARNING');
    expect(existence.note).toMatch(/never have been scheduled/i);
  });
});

// ---------------------------------------------------------------------------
describe('Sensitive-field masking', () => {
  it('masks accessToken and proctorCode by default', async () => {
    const { client } = clientFor({ status: { status: 200, ok: true, body: statusBody } });
    const r = await verifyTestCode({ testCode: CODE_PLAIN }, client);
    expect(r.localRecord!.accessToken).not.toBe('ACCESS-TOKEN-SECRET-VALUE');
    expect(r.localRecord!.accessToken).toContain('*');
    expect(r.localRecord!.proctorCode).toContain('*');
    expect(r.localRecord!._sensitiveRevealed).toBe(false);
  });

  it('reveals them only when explicitly requested', async () => {
    const { client } = clientFor({ status: { status: 200, ok: true, body: statusBody } });
    const r = await verifyTestCode({ testCode: CODE_PLAIN, revealSensitive: true }, client);
    expect(r.localRecord!.accessToken).toBe('ACCESS-TOKEN-SECRET-VALUE');
    expect(r.localRecord!.proctorCode).toBe('PROCTOR-SECRET-1');
  });

  it('never leaks workspace credentials into the response', async () => {
    const { client } = clientFor({ status: { status: 200, ok: true, body: statusBody } });
    const r = await verifyTestCode({ testCode: CODE_PLAIN, revealSensitive: true }, client);
    const blob = JSON.stringify(r);
    for (const secret of ['TOK-MV', 'apiToken', 'restApiKey', 'password', 'api_token']) {
      expect(blob).not.toContain(secret);
    }
  });
});

// ---------------------------------------------------------------------------
describe('Verification history', () => {
  it('records the attempt with timings and no credentials', async () => {
    const { client } = clientFor({
      status: { status: 200, ok: true, body: statusBody },
      results: { status: 404, ok: false, body: null },
    });
    await verifyTestCode({ testCode: CODE_PLAIN }, client);
    const rows = await recentChecks(CODE_NORM, 5);
    expect(rows.length).toBeGreaterThan(0);
    const latest = rows[0];
    expect(latest.statusRequestSuccess).toBe(true);
    expect(latest.resultsRequestSuccess).toBe(false);
    expect(latest.resultsHttpCode).toBe(404);
    expect(latest.localRecordFound).toBe(true);
    expect(JSON.stringify(latest)).not.toContain('TOK-MV');
  });
});

// ---------------------------------------------------------------------------
describe('RBAC and audit', () => {
  it('denies the page and the endpoint to a role without the permission', async () => {
    const agent = await agentFor(viewerEmail, VIEWER_PW);
    expect((await agent.get('/verify')).status).toBe(403);
    expect((await agent.post('/api/manual-verification/test-code').send({ testCode: CODE_PLAIN })).status).toBe(403);
  });

  it('requires authentication', async () => {
    expect((await request(app).post('/api/manual-verification/test-code').send({ testCode: CODE_PLAIN })).status).toBe(401);
  });

  it('rejects an empty Test Code with 400', async () => {
    const agent = await agentFor(adminEmail, ADMIN_PW);
    expect((await agent.post('/api/manual-verification/test-code').send({ testCode: '' })).status).toBe(400);
  });

  it('serves the page to an administrator and marks it read-only', async () => {
    const agent = await agentFor(adminEmail, ADMIN_PW);
    const res = await agent.get('/verify');
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/read-only/i);
    // The page must not offer any mutating action against FastTest.
    expect(res.text).not.toMatch(/createScheduling|POST \/tests\/registration|deleteRegistration/);
  });

  it('renders Arabic strings and an RTL container', async () => {
    const agent = await agentFor(adminEmail, ADMIN_PW);
    const html = (await agent.get('/verify')).text;
    expect(html).toContain('التحقق اليدوي');       // Arabic title
    expect(html).toContain('كود الاختبار');         // Arabic field label
    expect(html).toContain("'rtl'");                // dir flips to rtl
    expect(html).toContain('#mv[dir="rtl"]');       // RTL styling hook
  });

  it('writes an audit entry when a verification runs', async () => {
    const agent = await agentFor(adminEmail, ADMIN_PW);
    const before = await prisma.auditLog.count({ where: { action: 'MANUAL_VERIFICATION' } });
    await agent.post('/api/manual-verification/test-code').send({ testCode: 'AUDIT-000-000-001' });
    const after = await prisma.auditLog.count({ where: { action: 'MANUAL_VERIFICATION' } });
    expect(after).toBe(before + 1);
    const entry = await prisma.auditLog.findFirst({
      where: { action: 'MANUAL_VERIFICATION' }, orderBy: { createdAt: 'desc' },
    });
    expect(entry?.detail).not.toMatch(/token|apiKey|password/i);
  });

  it('audits an export action', async () => {
    const agent = await agentFor(adminEmail, ADMIN_PW);
    const res = await agent.post('/api/manual-verification/audit-export')
      .send({ kind: 'report-copy', testCode: CODE_NORM });
    expect(res.status).toBe(200);
    const entry = await prisma.auditLog.findFirst({
      where: { action: 'MANUAL_VERIFICATION_EXPORTED' }, orderBy: { createdAt: 'desc' },
    });
    expect(entry).toBeTruthy();
  });

  it('strips raw payloads for a role without view_raw_response', async () => {
    // Assessment Team may run checks and unmask local values, but not inspect
    // raw API payloads — the two grants are deliberately independent.
    const email = `mv-assess-${Date.now()}@t.local`;
    await makeUser(email, ADMIN_PW, ROLE.ASSESSMENT_TEAM);
    const agent = await agentFor(email, ADMIN_PW);

    const html = (await agent.get('/verify')).text;
    expect(html).toMatch(/"raw":false/);
    expect(html).not.toContain('id="mvRawStatus"'); // section not rendered at all

    const res = await agent.post('/api/manual-verification/test-code').send({ testCode: CODE_PLAIN });
    expect(res.status).toBe(200);
    expect(res.body.fastTest.status.data).toBeNull();
    expect(res.body.fastTest.results.data).toBeNull();
    expect(res.body.fastTest.status.url).toBeNull();
    // Outcome metadata still comes through, so the user can see WHAT happened.
    expect(res.body.fastTest.status).toHaveProperty('httpCode');
  });

  it('keeps sensitive values masked for a role without view_sensitive, even if asked', async () => {
    const email = `mv-ops-${Date.now()}@t.local`;
    await makeUser(email, ADMIN_PW, ROLE.OPERATIONS);
    const agent = await agentFor(email, ADMIN_PW);

    const res = await agent.post('/api/manual-verification/test-code')
      .send({ testCode: CODE_PLAIN, revealSensitive: true }); // asks anyway
    expect(res.status).toBe(200);
    expect(res.body.localRecord.accessToken).not.toBe('ACCESS-TOKEN-SECRET-VALUE');
    expect(res.body.localRecord.accessToken).toContain('*');
    expect(res.body.localRecord._sensitiveRevealed).toBe(false);
  });

  it('refuses a manual workspace override without integration rights', async () => {
    const email = `mv-ops2-${Date.now()}@t.local`;
    await makeUser(email, ADMIN_PW, ROLE.OPERATIONS);
    const agent = await agentFor(email, ADMIN_PW);
    const res = await agent.post('/api/manual-verification/test-code')
      .send({ testCode: CODE_PLAIN, workspaceId: WS_ID });
    expect(res.status).toBe(403);
  });

  it('exposes the permission set to the page so the UI can gate controls', async () => {
    const agent = await agentFor(adminEmail, ADMIN_PW);
    const html = (await agent.get('/verify')).text;
    expect(html).toMatch(/"execute":true/);
    expect(html).toMatch(/"sensitive":true/);
    expect(html).toMatch(/"raw":true/);
  });
});

// ---------------------------------------------------------------------------
describe('Exam time conversion (US clock -> UAE)', () => {
  it('converts the vendor clock into a UAE instant and says how', async () => {
    const { client } = clientFor({
      status: { status: 200, ok: true, body: statusBody },
      results: { status: 200, ok: true, body: resultsBody },
    });
    const r = await verifyTestCode({ testCode: CODE_PLAIN }, client);
    expect(r.examTime).toBeTruthy();
    expect(r.examTime!.raw).toBe('2026-07-01 08:00:00');
    expect(r.examTime!.sourceTimeZone).toBe('America/Chicago');
    expect(r.examTime!.displayTimeZone).toBe('Asia/Dubai');
    expect(r.examTime!.trustworthy).toBe(true);
    // 08:00 Chicago is 17:00 Dubai — past the 15:30 close, so a late sitting.
    // Its alternate, 05:00, is before the exam opens and therefore impossible.
    expect(r.examTime!.localStart).toBe('2026-07-01 17:00:00');
    expect(r.examTime!.note).toMatch(/converted to Asia\/Dubai/i);
  });

  it('recovers a reading the vendor sent without its AM/PM marker', async () => {
    const body = JSON.parse(JSON.stringify(resultsBody));
    // 01:00 Chicago -> 10:00 Dubai, inside the window; 13:00 -> 22:00, outside.
    body.examineeRegistrationResults[0].startTime = '2026-07-01 01:00:00';
    const { client } = clientFor({
      status: { status: 200, ok: true, body: statusBody },
      results: { status: 200, ok: true, body },
    });
    const r = await verifyTestCode({ testCode: CODE_PLAIN }, client);
    expect(r.examTime!.resolution).toBe('RESOLVED_AM');
    expect(r.examTime!.localStart).toBe('2026-07-01 10:00:00');
  });

  it('never reports a start before the exam window opens', async () => {
    const { client } = clientFor({
      status: { status: 200, ok: true, body: statusBody },
      results: { status: 200, ok: true, body: resultsBody },
    });
    const r = await verifyTestCode({ testCode: CODE_PLAIN }, client);
    expect(r.examTime!.localHour).toBeGreaterThanOrEqual(7);
  });

  it('always keeps the vendor original alongside the conversion', async () => {
    const { client } = clientFor({
      status: { status: 200, ok: true, body: statusBody },
      results: { status: 200, ok: true, body: resultsBody },
    });
    const r = await verifyTestCode({ testCode: CODE_PLAIN }, client);
    expect(r.examTime!.raw).toBe('2026-07-01 08:00:00');
    expect(r.examTime!.localStart).not.toBe(r.examTime!.raw);
  });
});
