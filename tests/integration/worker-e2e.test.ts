import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import { prisma } from '../../src/db/prisma';
import { FastTestClient } from '../../src/services/fasttest/client';
import { clearAllTokens } from '../../src/services/fasttest/token-cache';
import { HttpRequest, HttpResponse } from '../../src/services/fasttest/types';
import { enqueue } from '../../src/services/sync/queue.service';
import { processOneJob } from '../../src/workers/sync.worker';
import { resetBuckets, invalidateRateConfig } from '../../src/services/sync/rate-limiter.service';
import { encrypt } from '../../src/lib/crypto';
import { JOB_TYPE } from '../../src/lib/enums';
import { makeRegistration, clearRegistrations } from '../helpers/fixtures';

let wsId: string;

function scripted(map: (req: HttpRequest) => HttpResponse) {
  const calls: HttpRequest[] = [];
  return { calls, transport: async (req: HttpRequest) => { calls.push(req); return map(req); } };
}
const authOk: HttpResponse = { status: 200, ok: true, body: { apiToken: 'TOK', ttl: 3600 } };

async function workspace() {
  return prisma.fastTestWorkspace.create({
    data: { workspaceName: 'E2E WS', subjectCode: 'E2E', baseUrl: 'https://x.test/api', restApiKeyEncrypted: encrypt('k'), syncEnabled: true },
  });
}

beforeAll(async () => {
  wsId = (await workspace()).id;
});
beforeEach(async () => {
  await clearRegistrations();
  await prisma.syncJob.deleteMany({});
  await prisma.workspaceCircuitBreaker.deleteMany({});
  clearAllTokens();
  resetBuckets();
  invalidateRateConfig();
});

describe('Worker end-to-end (mock transport, durable queue)', () => {
  it('processes a status job to DONE and records state transitions', async () => {
    const reg = await makeRegistration({ workspaceId: wsId, status: 'UNKNOWN', examSubject: 'E2ESub' });
    await enqueue({ jobType: JOB_TYPE.SYNC_REGISTRATION_STATUS, workspaceId: wsId, registrationId: reg.id, subject: 'E2ESub' });

    const transport = async (r: HttpRequest): Promise<HttpResponse> => (r.url.includes('/auth') ? authOk : { status: 200, ok: true, body: { status: 'INPROGRESS' } });
    const client = new FastTestClient({ transport, now: () => Date.now() });
    const outcome = await processOneJob('wA', () => Date.now(), client);
    expect(outcome).toBe('DONE');

    const updated = await prisma.examRegistration.findUnique({ where: { id: reg.id } });
    expect(updated!.dashboardStatus).toBe('IN_PROGRESS');
    expect(updated!.syncState).toBe('STATUS_SYNCED');
    const transitions = await prisma.syncStateTransition.findMany({ where: { registrationId: reg.id } });
    // The transient SYNCING_STATUS marker is written without a history row (perf);
    // the meaningful STATUS_SYNCED transition is still recorded.
    expect(transitions.some((t) => t.toState === 'SYNCING_STATUS')).toBe(false);
    expect(transitions.some((t) => t.toState === 'STATUS_SYNCED')).toBe(true);
  });

  it('COMPLETED status enqueues a results job which then persists results', async () => {
    const reg = await makeRegistration({ workspaceId: wsId, status: 'UNKNOWN', examSubject: 'E2ESub' });
    await enqueue({ jobType: JOB_TYPE.SYNC_REGISTRATION_STATUS, workspaceId: wsId, registrationId: reg.id, subject: 'E2ESub' });

    const transport = async (req: HttpRequest): Promise<HttpResponse> => {
      if (req.url.includes('/auth')) return authOk;
      if (req.url.includes('/status')) return { status: 200, ok: true, body: { status: 'COMPLETED' } };
      return { status: 200, ok: true, body: { examineeRegistrationResults: [{ testName: 'X', secondsUsed: 900, passed: true, scores: [{ rawScore: 15, scaledScore: 200, scoredItems: { correct: 12, incorrect: 3, skipped: 5 }, totalItems: { correct: 12, incorrect: 3, skipped: 5 } }] }] } };
    };
    const client = new FastTestClient({ transport, now: () => Date.now() });

    await processOneJob('wA', () => Date.now(), client); // status job → enqueues results job
    const resultsJob = await prisma.syncJob.findFirst({ where: { registrationId: reg.id, jobType: JOB_TYPE.SYNC_REGISTRATION_RESULTS } });
    expect(resultsJob).not.toBeNull();

    await new Promise((r) => setTimeout(r, 260)); // clear the per-workspace min-delay
    let outcome = await processOneJob('wA', () => Date.now(), client); // results job
    if (outcome === 'RESCHEDULE') { await new Promise((r) => setTimeout(r, 260)); outcome = await processOneJob('wA', () => Date.now(), client); }
    const result = await prisma.fastTestResult.findFirst({ where: { registrationId: reg.id } });
    expect(result).not.toBeNull();
    expect(result!.rawScore).toBe(15);
    expect(result!.attemptedItems).toBe(15);
  });

  it('an auth failure dead-letters or manual-reviews (no fabricated data) and opens no false success', async () => {
    const reg = await makeRegistration({ workspaceId: wsId, status: 'UNKNOWN', examSubject: 'E2ESub' });
    await enqueue({ jobType: JOB_TYPE.SYNC_REGISTRATION_STATUS, workspaceId: wsId, registrationId: reg.id, subject: 'E2ESub', maxAttempts: 1 });
    const client = new FastTestClient({ transport: async () => ({ status: 401, ok: false, body: { message: 'bad key' } }), now: () => Date.now() });

    const outcome = await processOneJob('wA', () => Date.now(), client);
    expect(['DEAD_LETTER', 'MANUAL_REVIEW', 'RESCHEDULE']).toContain(outcome);
    const job = await prisma.syncJob.findFirst({ where: { registrationId: reg.id } });
    expect(['DEAD_LETTER', 'MANUAL_REVIEW', 'RETRY_SCHEDULED']).toContain(job!.status);
    const reloaded = await prisma.examRegistration.findUnique({ where: { id: reg.id } });
    expect(reloaded!.syncState).toBe('AUTH_FAILED');
  });

  it('does not double-process: a second worker finds nothing after the first claims', async () => {
    const reg = await makeRegistration({ workspaceId: wsId, status: 'UNKNOWN', examSubject: 'E2ESub' });
    await enqueue({ jobType: JOB_TYPE.SYNC_REGISTRATION_STATUS, workspaceId: wsId, registrationId: reg.id, subject: 'E2ESub' });
    const transport = async (r: HttpRequest): Promise<HttpResponse> => (r.url.includes('/auth') ? authOk : { status: 200, ok: true, body: { status: 'NEW' } });
    const client = new FastTestClient({ transport, now: () => Date.now() });

    const [a, b] = await Promise.all([processOneJob('wA', () => Date.now(), client), processOneJob('wB', () => Date.now(), client)]);
    const outcomes = [a, b].filter((x) => x !== null);
    expect(outcomes.length).toBe(1); // exactly one worker processed the job
  });
});
