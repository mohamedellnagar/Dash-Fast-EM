import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import { prisma } from '../../src/db/prisma';
import { currentThrottle, resetAdaptive } from '../../src/services/sync/adaptive.service';
import { runRetention } from '../../src/services/observability/retention.service';
import { env } from '../../src/config/env';

let wsId: string;
beforeAll(async () => {
  wsId = (await prisma.fastTestWorkspace.create({ data: { workspaceName: 'Adapt WS', subjectCode: 'ADAPT', baseUrl: 'https://x.test/api' } })).id;
});

describe('Adaptive throttling', () => {
  beforeEach(() => resetAdaptive());

  it('reduces throttle under high latency/error and stays above the floor', async () => {
    const T = Date.now();
    for (let i = 0; i < 6; i++) {
      await prisma.apiRequestLog.create({ data: { workspaceId: wsId, endpoint: '/status', method: 'GET', requestedAt: new Date(T - 1000), responseTimeMs: 6000, success: false, httpStatus: 500 } });
    }
    const t1 = await currentThrottle(wsId, () => T);
    expect(t1).toBeLessThan(1);
    const t2 = await currentThrottle(wsId, () => T + 1000);
    expect(t2).toBeLessThanOrEqual(t1);
    expect(t2).toBeGreaterThanOrEqual(env.adaptive.minThrottle);
  });

  it('recovers toward 1 once healthy and the recovery window passes', async () => {
    const T = Date.now();
    for (let i = 0; i < 6; i++) {
      await prisma.apiRequestLog.create({ data: { workspaceId: wsId, endpoint: '/status', method: 'GET', requestedAt: new Date(T - 1000), responseTimeMs: 6000, success: false } });
    }
    const degraded = await currentThrottle(wsId, () => T);
    // Advance past the window (logs fall out of the 2-min window) + recovery period.
    const later = T + env.adaptive.recoverAfterMs + 200000;
    const recovered = await currentThrottle(wsId, () => later);
    expect(recovered).toBeGreaterThan(degraded);
  });
});

describe('Retention cleanup', () => {
  it('prunes old data but preserves active jobs and unresolved alerts', async () => {
    const old = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);
    await prisma.apiRequestLog.create({ data: { workspaceId: wsId, endpoint: '/x', method: 'GET', requestedAt: old, success: true } });
    const oldDone = await prisma.syncJob.create({ data: { jobType: 'SYNC_REGISTRATION_STATUS', status: 'DONE', completedAt: old } });
    const activeJob = await prisma.syncJob.create({ data: { jobType: 'SYNC_REGISTRATION_STATUS', status: 'QUEUED' } });
    const alert = await prisma.systemAlert.create({ data: { alertType: 'QUEUE_BACKLOG', severity: 'HIGH', title: 'old', status: 'OPEN', firstSeenAt: old, lastSeenAt: old } });

    const res = await runRetention();
    expect(res.completedJobs).toBeGreaterThanOrEqual(1);

    expect(await prisma.syncJob.findUnique({ where: { id: oldDone.id } })).toBeNull(); // pruned
    expect(await prisma.syncJob.findUnique({ where: { id: activeJob.id } })).not.toBeNull(); // kept (active)
    expect(await prisma.systemAlert.findUnique({ where: { id: alert.id } })).not.toBeNull(); // kept (unresolved)
  });
});
