import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import { prisma } from '../../src/db/prisma';
import {
  enqueue, claimNext, completeJob, failJob, cancelJob, retryJob, requeueDeadLetter,
  retryFailedJobs, recoverStalledJobs, pauseWorkspace, pauseJobType, queueStats,
} from '../../src/services/sync/queue.service';
import { invalidateRateConfig } from '../../src/services/sync/rate-limiter.service';
import { JOB_TYPE, ERROR_CATEGORY } from '../../src/lib/enums';

let wsId: string;

beforeAll(async () => {
  wsId = (await prisma.fastTestWorkspace.create({ data: { workspaceName: 'Queue WS', subjectCode: 'QUEUE', baseUrl: 'https://x.test/api' } })).id;
});

beforeEach(async () => {
  await prisma.syncJobAttempt.deleteMany({});
  await prisma.syncJob.deleteMany({});
  await prisma.workspaceCircuitBreaker.deleteMany({});
  await prisma.workspaceRateLimit.deleteMany({});
  await prisma.queueControl.deleteMany({});
  invalidateRateConfig();
});

describe('Durable queue', () => {
  it('enqueues and dedupes by key', async () => {
    const a = await enqueue({ jobType: JOB_TYPE.SYNC_REGISTRATION_STATUS, workspaceId: wsId, dedupeKey: 'dk-1' });
    const b = await enqueue({ jobType: JOB_TYPE.SYNC_REGISTRATION_STATUS, workspaceId: wsId, dedupeKey: 'dk-1' });
    expect(a.deduped).toBe(false);
    expect(b.deduped).toBe(true);
    expect(b.job.id).toBe(a.job.id);
  });

  it('claims a job atomically — a second worker cannot re-claim it', async () => {
    await enqueue({ jobType: JOB_TYPE.MANUAL_SYNC, workspaceId: wsId, dedupeKey: 'dk-2' });
    const j1 = await claimNext('workerA');
    const j2 = await claimNext('workerB');
    expect(j1).not.toBeNull();
    expect(j1.status).toBe('RUNNING');
    expect(j1.lockedBy).toBe('workerA');
    expect(j2).toBeNull(); // nothing left to claim
  });

  it('completes a job and records an attempt', async () => {
    await enqueue({ jobType: JOB_TYPE.MANUAL_SYNC, workspaceId: wsId, dedupeKey: 'dk-3' });
    const job = await claimNext('w');
    await completeJob(job, 'w', 123, '/status');
    const done = await prisma.syncJob.findUnique({ where: { id: job.id } });
    expect(done!.status).toBe('DONE');
    const attempt = await prisma.syncJobAttempt.findFirst({ where: { jobId: job.id } });
    expect(attempt!.status).toBe('SUCCESS');
  });

  it('schedules a retry on retryable failure', async () => {
    await enqueue({ jobType: JOB_TYPE.SYNC_REGISTRATION_STATUS, workspaceId: wsId, dedupeKey: 'dk-4', maxAttempts: 3 });
    const job = await claimNext('w');
    const r = await failJob(job, 'w', { category: ERROR_CATEGORY.TIMEOUT, message: 'slow' }, 50);
    expect(r.action).toBe('RETRY');
    const after = await prisma.syncJob.findUnique({ where: { id: job.id } });
    expect(after!.status).toBe('RETRY_SCHEDULED');
    expect(after!.nextRetryAt).not.toBeNull();
    expect(after!.lockedBy).toBeNull();
  });

  it('dead-letters after max attempts', async () => {
    await enqueue({ jobType: JOB_TYPE.SYNC_REGISTRATION_STATUS, workspaceId: wsId, dedupeKey: 'dk-5', maxAttempts: 1 });
    const job = await claimNext('w'); // attemptCount → 1
    const r = await failJob(job, 'w', { category: ERROR_CATEGORY.FASTTEST_INTERNAL_ERROR, message: '500' }, 50);
    expect(r.action).toBe('DEAD_LETTER');
    const after = await prisma.syncJob.findUnique({ where: { id: job.id } });
    expect(after!.status).toBe('DEAD_LETTER');
  });

  it('requeues a dead-letter job', async () => {
    await enqueue({ jobType: JOB_TYPE.SYNC_REGISTRATION_STATUS, workspaceId: wsId, dedupeKey: 'dk-6', maxAttempts: 1 });
    const job = await claimNext('w');
    await failJob(job, 'w', { category: ERROR_CATEGORY.INVALID_TEST_CODE, message: 'bad' }, 10);
    expect(await requeueDeadLetter(job.id)).toBe(true);
    const after = await prisma.syncJob.findUnique({ where: { id: job.id } });
    expect(after!.status).toBe('QUEUED');
    expect(after!.attemptCount).toBe(0);
  });

  it('cancels a queued job', async () => {
    const { job } = await enqueue({ jobType: JOB_TYPE.SYNC_REGISTRATION_STATUS, workspaceId: wsId, dedupeKey: 'dk-7' });
    expect(await cancelJob(job.id)).toBe(true);
    const after = await prisma.syncJob.findUnique({ where: { id: job.id } });
    expect(after!.status).toBe('CANCELLED');
  });

  it('does not claim jobs for a paused workspace', async () => {
    await enqueue({ jobType: JOB_TYPE.SYNC_REGISTRATION_STATUS, workspaceId: wsId, dedupeKey: 'dk-8' });
    await pauseWorkspace(wsId, true);
    expect(await claimNext('w')).toBeNull();
    await pauseWorkspace(wsId, false);
    expect(await claimNext('w')).not.toBeNull();
  });

  it('does not claim paused job types', async () => {
    await enqueue({ jobType: JOB_TYPE.REFRESH_ANALYTICS_CACHE, dedupeKey: 'dk-jt' });
    await pauseJobType(JOB_TYPE.REFRESH_ANALYTICS_CACHE, true);
    expect(await claimNext('w')).toBeNull();
  });

  it('enforces per-workspace concurrency', async () => {
    await prisma.workspaceRateLimit.create({ data: { workspaceId: wsId, maxConcurrent: 1 } });
    invalidateRateConfig();
    // one already RUNNING (no registration FK needed)
    await prisma.syncJob.create({ data: { jobType: JOB_TYPE.SYNC_REGISTRATION_STATUS, workspaceId: wsId, status: 'RUNNING', lockedBy: 'other' } });
    await enqueue({ jobType: JOB_TYPE.SYNC_REGISTRATION_STATUS, workspaceId: wsId, dedupeKey: 'dk-9' });
    expect(await claimNext('w')).toBeNull(); // capped at 1
  });

  it('recovers stalled RUNNING jobs', async () => {
    const old = new Date(Date.now() - 10 * 60 * 1000);
    const stalled = await prisma.syncJob.create({ data: { jobType: JOB_TYPE.SYNC_REGISTRATION_STATUS, workspaceId: wsId, status: 'RUNNING', lockedBy: 'dead', lockedAt: old, heartbeatAt: old } });
    const n = await recoverStalledJobs();
    expect(n).toBeGreaterThanOrEqual(1);
    const job = await prisma.syncJob.findUnique({ where: { id: stalled.id } });
    expect(job!.status).toBe('RETRY_SCHEDULED');
    expect(job!.lockedBy).toBeNull();
  });

  it('bulk-requeues failed jobs and reports stats', async () => {
    await prisma.syncJob.create({ data: { jobType: JOB_TYPE.SYNC_REGISTRATION_STATUS, workspaceId: wsId, status: 'DEAD_LETTER' } });
    const n = await retryFailedJobs({ workspaceId: wsId });
    expect(n).toBeGreaterThanOrEqual(1);
    const stats = await queueStats();
    expect(stats.queued).toBeGreaterThanOrEqual(1);
  });
});
