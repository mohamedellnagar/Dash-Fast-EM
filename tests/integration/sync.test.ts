import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '../../src/db/prisma';
import { FastTestClient } from '../../src/services/fasttest/client';
import { clearAllTokens } from '../../src/services/fasttest/token-cache';
import { HttpRequest, HttpResponse } from '../../src/services/fasttest/types';
import { syncRegistration } from '../../src/services/sync/sync.service';
import { encrypt } from '../../src/lib/crypto';
import { DASHBOARD_STATUS, SYNC_STATUS } from '../../src/lib/enums';

const NOW = 1_700_000_000_000;

function scripted(responses: HttpResponse[]) {
  let i = 0;
  const calls: HttpRequest[] = [];
  return {
    calls,
    transport: async (req: HttpRequest): Promise<HttpResponse> => {
      calls.push(req);
      return responses[Math.min(i++, responses.length - 1)];
    },
  };
}

async function makeWorkspaceAndReg(testCode: string) {
  const normalized = testCode.replace(/-/g, '');
  // Idempotent: clear any registration from a prior run for this test code.
  await prisma.examRegistration.deleteMany({
    where: { studentExternalId: `ST-${testCode}`, testCodeNormalized: normalized },
  });
  const ws =
    (await prisma.fastTestWorkspace.findFirst({ where: { subjectCode: 'SYNCTEST' } })) ??
    (await prisma.fastTestWorkspace.create({
      data: {
        workspaceName: 'Sync Test WS',
        subjectCode: 'SYNCTEST',
        baseUrl: 'https://example.test/api',
        restApiKeyEncrypted: encrypt('sync-key'),
        tokenTTL: 3600,
        isActive: true,
        syncEnabled: true,
      },
    }));
  const reg = await prisma.examRegistration.create({
    data: {
      studentExternalId: `ST-${testCode}`,
      examSubject: 'SyncTest Subject',
      testCodeOriginal: testCode,
      testCodeNormalized: testCode.replace(/-/g, ''),
      workspaceId: ws.id,
    },
  });
  return { ws, reg };
}

const authOk: HttpResponse = { status: 200, ok: true, body: { apiToken: 'TOK', ttl: 3600 } };

describe('syncRegistration (end-to-end with mock transport)', () => {
  beforeEach(() => clearAllTokens());

  it('persists status snapshot, denormalizes fields, and fetches results when COMPLETED', async () => {
    const { reg } = await makeWorkspaceAndReg('CMP-1-2');
    const statusResp: HttpResponse = {
      status: 200, ok: true,
      body: { status: 'COMPLETED', testId: 77, testName: 'Arabic', examineeId: 9, registrationDate: '2026-07-10' },
    };
    const resultsResp: HttpResponse = {
      status: 200, ok: true,
      body: {
        firstName: 'A', lastName: 'B',
        examineeRegistrationResults: [{
          testName: 'Arabic', startTime: '2026-07-13T09:00:00', secondsUsed: 1800, passed: true,
          scores: [{ rawScore: 10, scaledScore: 200, scoredItems: { correct: 8, incorrect: 2, skipped: 5 }, totalItems: { correct: 8, incorrect: 2, skipped: 5 } }],
        }],
      },
    };
    const { transport } = scripted([authOk, statusResp, resultsResp]);
    const client = new FastTestClient({ transport, now: () => NOW });

    const out = await syncRegistration(reg.id, client, () => NOW);
    expect(out.ok).toBe(true);
    expect(out.dashboardStatus).toBe(DASHBOARD_STATUS.COMPLETED);

    const updated = await prisma.examRegistration.findUnique({ where: { id: reg.id } });
    expect(updated!.dashboardStatus).toBe(DASHBOARD_STATUS.COMPLETED);
    expect(updated!.fastTestStatus).toBe('COMPLETED');
    expect(updated!.syncStatus).toBe(SYNC_STATUS.OK);
    expect(updated!.nextSyncAt).not.toBeNull();
    expect(updated!.secondsUsed).toBe(1800);

    const snap = await prisma.fastTestStatusSnapshot.findFirst({ where: { registrationId: reg.id } });
    expect(snap).not.toBeNull();
    expect(JSON.parse(snap!.rawJson).testId).toBe(77);

    const result = await prisma.fastTestResult.findFirst({ where: { registrationId: reg.id }, include: { scores: true } });
    expect(result).not.toBeNull();
    expect(result!.attemptedItems).toBe(10); // 8 + 2
    expect(result!.totalItemsCount).toBe(15); // 8 + 2 + 5
    expect(result!.scores[0].scaledScore).toBe(200);
  });

  it('does NOT fetch results while IN_PROGRESS and schedules a fast next sync', async () => {
    const { reg } = await makeWorkspaceAndReg('INP-9');
    const statusResp: HttpResponse = { status: 200, ok: true, body: { status: 'INPROGRESS' } };
    const { transport, calls } = scripted([authOk, statusResp]);
    const client = new FastTestClient({ transport, now: () => NOW });

    const out = await syncRegistration(reg.id, client, () => NOW);
    expect(out.dashboardStatus).toBe(DASHBOARD_STATUS.IN_PROGRESS);
    // only auth + status calls, no results
    expect(calls.filter((c) => c.url.includes('/results'))).toHaveLength(0);
    const updated = await prisma.examRegistration.findUnique({ where: { id: reg.id } });
    // IN_PROGRESS cadence is 1800s (30 min), plus 0..15%-capped-at-300s jitter to
    // de-synchronize the herd. Status changed (NOT_SYNCED→IN_PROGRESS) so there is
    // no adaptive backoff yet.
    const t = updated!.nextSyncAt!.getTime();
    expect(t).toBeGreaterThanOrEqual(NOW + 1800 * 1000);
    expect(t).toBeLessThanOrEqual(NOW + (1800 + 270) * 1000);
  });

  it('marks a 404 as MANUAL_REVIEW (permanent error, no infinite retry)', async () => {
    const { reg } = await makeWorkspaceAndReg('NF-404');
    const notFound: HttpResponse = { status: 404, ok: false, body: { message: 'not found' } };
    const { transport } = scripted([authOk, notFound]);
    const client = new FastTestClient({ transport, now: () => NOW });

    const out = await syncRegistration(reg.id, client, () => NOW);
    expect(out.ok).toBe(false);
    expect(out.manualReview).toBe(true);
    const updated = await prisma.examRegistration.findUnique({ where: { id: reg.id } });
    expect(updated!.syncStatus).toBe(SYNC_STATUS.MANUAL_REVIEW);
    expect(updated!.nextSyncAt).toBeNull(); // not rescheduled
  });
});
