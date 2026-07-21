import { Router } from 'express';
import { prisma } from '../db/prisma';
import { env } from '../config/env';
import { version } from '../lib/version';

export const healthRouter = Router();

// Liveness probe. `/healthz` is a conventional alias for external monitors/k8s.
healthRouter.get(['/health', '/healthz'], (_req, res) => {
  res.json({ status: 'ok', service: 'fasttest-dashboard', version, time: new Date().toISOString() });
});

healthRouter.get('/health/database', async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: 'ok', database: 'reachable' });
  } catch (e) {
    res.status(503).json({ status: 'error', database: 'unreachable', message: (e as Error).message });
  }
});

healthRouter.get('/health/queue', async (_req, res) => {
  try {
    const [queued, running, retry, deadLetter, manual] = await Promise.all([
      prisma.syncJob.count({ where: { status: 'QUEUED' } }),
      prisma.syncJob.count({ where: { status: 'RUNNING' } }),
      prisma.syncJob.count({ where: { status: 'RETRY_SCHEDULED' } }),
      prisma.syncJob.count({ where: { status: 'DEAD_LETTER' } }),
      prisma.syncJob.count({ where: { status: 'MANUAL_REVIEW' } }),
    ]);
    res.json({ status: 'ok', queued, running, retryScheduled: retry, deadLetter, manualReview: manual, syncEnabled: env.sync.enabled });
  } catch (e) {
    res.status(503).json({ status: 'error', message: (e as Error).message });
  }
});

healthRouter.get('/health/fasttest', async (_req, res) => {
  try {
    const workspaces = await prisma.fastTestWorkspace.findMany({
      where: { deletedAt: null },
      select: {
        workspaceName: true, subjectCode: true, isActive: true, syncEnabled: true,
        lastAuthenticationStatus: true, lastAuthenticationAt: true, lastSuccessfulSyncAt: true,
      },
    });
    const staleThresholdMs = 15 * 60 * 1000;
    const now = Date.now();
    const enriched = workspaces.map((w) => ({
      ...w,
      stale: w.lastSuccessfulSyncAt ? now - w.lastSuccessfulSyncAt.getTime() > staleThresholdMs : true,
    }));
    res.json({ status: 'ok', workspaces: enriched });
  } catch (e) {
    res.status(503).json({ status: 'error', message: (e as Error).message });
  }
});
