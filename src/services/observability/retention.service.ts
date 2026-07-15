import { prisma } from '../../db/prisma';
import { env } from '../../config/env';
import { logger } from '../../lib/logger';

// Configurable retention cleanup. NEVER deletes active jobs or unresolved
// alerts/incidents. Completed/terminal jobs, old logs, heartbeats and metric
// snapshots are pruned by age. Safe to run repeatedly (idempotent).

function cutoff(days: number, now: number): Date {
  return new Date(now - days * 24 * 60 * 60 * 1000);
}

export interface RetentionResult {
  apiLogs: number;
  completedJobs: number;
  failedJobs: number;
  heartbeats: number;
  queueSnapshots: number;
  healthSnapshots: number;
  auditLogs: number;
  attempts: number;
}

export async function runRetention(now: () => number = () => Date.now()): Promise<RetentionResult> {
  const t = now();
  const r = env.retention;

  const [apiLogs, completedJobs, failedJobs, heartbeats, queueSnapshots, healthSnapshots, auditLogs] = await Promise.all([
    prisma.apiRequestLog.deleteMany({ where: { requestedAt: { lt: cutoff(r.apiLogsDays, t) } } }),
    prisma.syncJob.deleteMany({ where: { status: { in: ['DONE', 'CANCELLED'] }, completedAt: { lt: cutoff(r.completedJobsDays, t) } } }),
    prisma.syncJob.deleteMany({ where: { status: { in: ['DEAD_LETTER', 'MANUAL_REVIEW'] }, completedAt: { lt: cutoff(r.failedJobsDays, t) } } }),
    prisma.workerHeartbeat.deleteMany({ where: { createdAt: { lt: cutoff(r.heartbeatDays, t) } } }),
    prisma.queueMetricSnapshot.deleteMany({ where: { createdAt: { lt: cutoff(r.metricsDays, t) } } }),
    prisma.workspaceHealthSnapshot.deleteMany({ where: { createdAt: { lt: cutoff(r.metricsDays, t) } } }),
    prisma.auditLog.deleteMany({ where: { createdAt: { lt: cutoff(r.auditDays, t) } } }),
  ]);

  // Orphaned job attempts (whose job was pruned) are removed by FK cascade; also
  // prune very old attempts defensively.
  const attempts = await prisma.syncJobAttempt.deleteMany({ where: { startedAt: { lt: cutoff(r.failedJobsDays, t) } } });

  const result: RetentionResult = {
    apiLogs: apiLogs.count, completedJobs: completedJobs.count, failedJobs: failedJobs.count,
    heartbeats: heartbeats.count, queueSnapshots: queueSnapshots.count, healthSnapshots: healthSnapshots.count,
    auditLogs: auditLogs.count, attempts: attempts.count,
  };
  logger.info(result, 'retention cleanup complete');
  return result;
}
