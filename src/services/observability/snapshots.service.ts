import { prisma } from '../../db/prisma';
import { CIRCUIT_STATE } from '../../lib/enums';
import { metrics } from './metrics.service';
import { queueStats } from '../sync/queue.service';
import { rollingStats } from '../sync/adaptive.service';
import { activeWorkerCount } from '../sync/worker-registry.service';

const CIRCUIT_CODE: Record<string, number> = { CLOSED: 0, HALF_OPEN: 1, OPEN: 2 };

/** Capture a queue KPI + per-workspace health snapshot and update gauges. */
export async function captureSnapshots(now: () => number = () => Date.now()): Promise<void> {
  const [stats, workers, staleCount] = await Promise.all([
    queueStats(now),
    activeWorkerCount(now),
    prisma.examRegistration.count({ where: { isStale: true, deletedAt: null } }),
  ]);

  await prisma.queueMetricSnapshot.create({
    data: {
      queuedJobs: stats.queued, runningJobs: stats.running, retryScheduled: stats.retryScheduled,
      deadLetterJobs: stats.deadLetter, completedLastMin: stats.jobsLastMin - stats.failedLastMin,
      failedLastMin: stats.failedLastMin, oldestJobAgeMs: stats.oldestQueuedAgeMs,
      activeWorkers: workers, staleRegistrations: staleCount,
    },
  });

  // Update Prometheus gauges.
  metrics.queueDepth.set(stats.queued);
  metrics.oldestJobAge.set(stats.oldestQueuedAgeMs);
  metrics.activeWorkers.set(workers);
  metrics.staleRegistrations.set(staleCount);

  const workspaces = await prisma.fastTestWorkspace.findMany({ where: { deletedAt: null }, include: { circuitBreaker: true } });
  for (const w of workspaces) {
    const rs = await rollingStats(w.id, now);
    const state = w.circuitBreaker?.state ?? CIRCUIT_STATE.CLOSED;
    metrics.circuitState.set(CIRCUIT_CODE[state] ?? 0, { workspace: w.id });
    await prisma.workspaceHealthSnapshot.create({
      data: {
        workspaceId: w.id, circuitState: state, avgResponseMs: rs.avgMs, p95ResponseMs: rs.p95,
        errorRate: rs.errorRate, requestCount: rs.count,
        staleCount: await prisma.examRegistration.count({ where: { workspaceId: w.id, isStale: true, deletedAt: null } }),
      },
    });
  }
}
