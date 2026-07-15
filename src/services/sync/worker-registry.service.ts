import os from 'os';
import { prisma } from '../../db/prisma';
import { env } from '../../config/env';
import { WORKER_STATUS } from '../../lib/enums';

// Worker registry: registration, heartbeat, health classification and stalled
// detection. Backed by WorkerInstance + WorkerHeartbeat so the queue dashboard
// and alerts can observe worker fleet health across processes.

export interface WorkerRuntime {
  jobsCompleted: number;
  jobsFailed: number;
  currentJobs: number;
  totalDurationMs: number;
}

export async function registerWorker(workerId: string, version = '0.3.0'): Promise<void> {
  await prisma.workerInstance.upsert({
    where: { id: workerId },
    create: { id: workerId, hostname: os.hostname(), pid: process.pid, version, status: WORKER_STATUS.HEALTHY },
    update: { status: WORKER_STATUS.HEALTHY, startedAt: new Date(), stoppedAt: null, lastHeartbeatAt: new Date() },
  });
}

export async function heartbeat(workerId: string, rt: WorkerRuntime): Promise<void> {
  const mem = process.memoryUsage();
  const memoryMb = Math.round(mem.rss / (1024 * 1024));
  const avg = rt.jobsCompleted > 0 ? Math.round(rt.totalDurationMs / rt.jobsCompleted) : 0;
  await prisma.workerInstance.update({
    where: { id: workerId },
    data: {
      status: WORKER_STATUS.HEALTHY, lastHeartbeatAt: new Date(),
      currentJobs: rt.currentJobs, jobsCompleted: rt.jobsCompleted, jobsFailed: rt.jobsFailed,
      avgJobDurationMs: avg, memoryMb,
    },
  }).catch(() => undefined);
  await prisma.workerHeartbeat.create({ data: { workerId, status: WORKER_STATUS.HEALTHY, currentJobs: rt.currentJobs, memoryMb } }).catch(() => undefined);
}

export async function markStopped(workerId: string): Promise<void> {
  await prisma.workerInstance.update({ where: { id: workerId }, data: { status: WORKER_STATUS.OFFLINE, stoppedAt: new Date(), currentJobs: 0 } }).catch(() => undefined);
}

/** Classify workers whose heartbeat has lapsed (called by monitoring/recovery). */
export async function reconcileWorkerHealth(now: () => number = () => Date.now()): Promise<{ stale: number; offline: number }> {
  const staleCut = new Date(now() - env.sync.workerStaleMs);
  const offlineCut = new Date(now() - env.sync.workerStaleMs * 3);
  // Purge long-dead workers so restarts don't accumulate OFFLINE rows forever.
  const purgeCut = new Date(now() - env.sync.workerStaleMs * 10);
  const [offline, stale] = await Promise.all([
    prisma.workerInstance.updateMany({ where: { status: { not: WORKER_STATUS.OFFLINE }, lastHeartbeatAt: { lt: offlineCut } }, data: { status: WORKER_STATUS.OFFLINE } }),
    prisma.workerInstance.updateMany({ where: { status: WORKER_STATUS.HEALTHY, lastHeartbeatAt: { lt: staleCut, gte: offlineCut } }, data: { status: WORKER_STATUS.STALE } }),
  ]);
  await prisma.workerInstance.deleteMany({ where: { lastHeartbeatAt: { lt: purgeCut } } }).catch(() => undefined);
  return { stale: stale.count, offline: offline.count };
}

export async function activeWorkerCount(now: () => number = () => Date.now()): Promise<number> {
  const cut = new Date(now() - env.sync.workerStaleMs);
  return prisma.workerInstance.count({ where: { status: WORKER_STATUS.HEALTHY, lastHeartbeatAt: { gte: cut } } });
}

export async function listWorkers() {
  return prisma.workerInstance.findMany({ orderBy: { lastHeartbeatAt: 'desc' } });
}
