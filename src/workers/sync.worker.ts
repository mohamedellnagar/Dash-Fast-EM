import os from 'os';
import { v4 as uuid } from 'uuid';
import { env } from '../config/env';
import { prisma } from '../db/prisma';
import { retryOnDeadlock } from '../db/retry';
import { logger } from '../lib/logger';
import { claimNext, completeJob, failJob, heartbeatJob, recoverStalledJobs } from '../services/sync/queue.service';
import { runJob } from '../services/sync/handlers';
import { FastTestClient, fastTestClient } from '../services/fasttest/client';
import { enqueueDueJobs, refreshStaleFlags } from '../services/sync/scheduler.service';
import { reapExpiredLocks } from '../services/sync/lock.service';
import { registerWorker, heartbeat, markStopped, reconcileWorkerHealth, WorkerRuntime } from '../services/sync/worker-registry.service';
import { captureSnapshots } from '../services/observability/snapshots.service';
import { runAlertDetectors } from '../services/observability/alert.service';
import { runRetention } from '../services/observability/retention.service';

export const WORKER_ID = `worker-${os.hostname()}-${process.pid}-${uuid().slice(0, 6)}`;

const runtime: WorkerRuntime = { jobsCompleted: 0, jobsFailed: 0, currentJobs: 0, totalDurationMs: 0 };

/** Claim and fully process exactly one job. Returns the outcome (or null if idle). */
export async function processOneJob(workerId = WORKER_ID, now: () => number = () => Date.now(), client: FastTestClient = fastTestClient): Promise<string | null> {
  const job = await retryOnDeadlock(() => claimNext(workerId, now));
  if (!job) return null;

  runtime.currentJobs++;
  const start = now();
  // Heartbeat the job while it runs (protects against stalled detection).
  const hb = setInterval(() => heartbeatJob(job.id, workerId).catch(() => undefined), Math.max(2000, Math.floor(env.sync.jobLockTtlMs / 3)));
  try {
    const outcome = await runJob(job, client);
    const durationMs = now() - start;
    if (outcome.kind === 'DONE') {
      await retryOnDeadlock(() => completeJob(job, workerId, durationMs));
      runtime.jobsCompleted++;
      runtime.totalDurationMs += durationMs;
      return 'DONE';
    }
    if (outcome.kind === 'RESCHEDULE') {
      await retryOnDeadlock(() => prisma.syncJob.update({
        where: { id: job.id },
        data: { status: 'RETRY_SCHEDULED', nextRetryAt: new Date(now() + outcome.delayMs), lockedBy: null, lockedAt: null, attemptCount: { decrement: 1 } },
      }));
      return 'RESCHEDULE';
    }
    // FAIL
    const res = await retryOnDeadlock(() => failJob(job, workerId, outcome, durationMs, outcome.endpoint, now));
    runtime.jobsFailed++;
    return res.action;
  } catch (e) {
    await retryOnDeadlock(() => failJob(job, workerId, { category: 'QUEUE' as any, message: (e as Error).message }, now() - start, undefined, now)).catch(() => undefined);
    runtime.jobsFailed++;
    logger.error({ jobId: job.id, err: (e as Error).message }, 'job processing threw');
    return 'FAIL';
  } finally {
    clearInterval(hb);
    runtime.currentJobs--;
  }
}

/** Scheduler tick: enqueue due jobs + recover stalled + reap locks + worker health. */
export async function runSchedulerTick(now: () => number = () => Date.now()): Promise<void> {
  await Promise.all([
    enqueueDueJobs(now).catch((e) => logger.warn({ err: (e as Error).message }, 'enqueueDueJobs failed')),
    recoverStalledJobs(now).catch(() => 0),
    reapExpiredLocks(now).catch(() => 0),
    reconcileWorkerHealth(now).catch(() => ({ stale: 0, offline: 0 })),
  ]);
}

async function main(): Promise<void> {
  await registerWorker(WORKER_ID);
  logger.info({ worker: WORKER_ID, concurrency: env.sync.concurrency }, 'sync worker started (durable queue)');

  let running = true;
  const stop = () => {
    if (running) logger.info({ worker: WORKER_ID }, 'graceful shutdown requested');
    running = false;
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);

  // Backstop: a transient error (e.g. a full temp disk making a query fail) must
  // NOT kill the worker — that silently stops all sync until a manual restart.
  // Log and keep the main loop running; the failed job is retried by the queue.
  process.on('unhandledRejection', (reason: unknown) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    logger.error({ worker: WORKER_ID, err: err.message, stack: err.stack }, 'unhandledRejection (worker kept alive)');
  });
  process.on('uncaughtException', (err: Error) => {
    logger.error({ worker: WORKER_ID, err: err.message, stack: err.stack }, 'uncaughtException (worker kept alive)');
  });

  // Heartbeat loop.
  const hbTimer = setInterval(() => heartbeat(WORKER_ID, runtime).catch(() => undefined), env.sync.heartbeatMs);

  // Scheduler loop (idempotent via queue dedup — safe on every worker).
  let lastScheduler = 0;
  let lastMaintenance = 0;
  let lastStale = 0;
  let lastRetention = 0;

  // Job-runner pool: N concurrent runners pulling from the queue.
  const runner = async () => {
    while (running) {
      if (!env.sync.enabled) {
        await sleep(env.sync.tickIntervalMs);
        continue;
      }
      const outcome = await processOneJob().catch((e) => {
        logger.error({ err: (e as Error).message }, 'runner error');
        return null;
      });
      if (outcome === null) await sleep(1000); // idle backoff
    }
  };
  const runners = Array.from({ length: env.sync.concurrency }, () => runner());

  // Periodic orchestration loop.
  const orchestrator = async () => {
    while (running) {
      const now = Date.now();
      if (env.sync.schedulerEnabled && now - lastScheduler >= env.sync.schedulerIntervalMs) {
        lastScheduler = now;
        await runSchedulerTick().catch((e) => logger.warn({ err: (e as Error).message }, 'scheduler tick failed'));
      }
      if (now - lastStale >= 5 * 60 * 1000) {
        lastStale = now;
        await refreshStaleFlags().catch(() => 0);
      }
      if (now - lastMaintenance >= 60 * 1000) {
        lastMaintenance = now;
        await captureSnapshots().catch((e) => logger.warn({ err: (e as Error).message }, 'snapshot failed'));
        await runAlertDetectors().catch((e) => logger.warn({ err: (e as Error).message }, 'alert detectors failed'));
      }
      if (now - lastRetention >= 6 * 60 * 60 * 1000) {
        lastRetention = now;
        await runRetention().catch((e) => logger.warn({ err: (e as Error).message }, 'retention failed'));
      }
      await sleep(2000);
    }
  };

  await Promise.all([...runners, orchestrator()]);

  clearInterval(hbTimer);
  await markStopped(WORKER_ID).catch(() => undefined);
  await prisma.$disconnect();
  logger.info({ worker: WORKER_ID }, 'worker stopped cleanly');
  process.exit(0);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

if (require.main === module) {
  main().catch((e) => {
    logger.error({ err: (e as Error).message }, 'sync worker crashed');
    process.exit(1);
  });
}
