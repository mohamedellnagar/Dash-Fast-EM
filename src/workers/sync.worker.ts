import os from 'os';
import http from 'http';
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

// Tiny health endpoint so container/orchestrator health checks pass. The worker
// has no HTTP API, but platforms (EasyPanel/Swarm) probe /health and would
// restart the container in a loop without a 200 response.
function startHealthServer(): void {
  const server = http.createServer((req, res) => {
    if (req.url === '/health' || req.url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', role: 'worker', worker: WORKER_ID }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  server.on('error', (e) => logger.warn({ err: (e as Error).message }, 'worker health server error'));
  server.listen(env.port, () => logger.info({ port: env.port }, 'worker health endpoint listening'));
}

/**
 * Run the worker's runner pool + orchestration loops until `stop()` is called.
 * Extracted so the same loops power both the standalone worker process and the
 * embedded worker inside the web process (WORKER_IN_WEB=true) — the only
 * difference is the caller owns the health server, signal handlers, and exit.
 * Returns a stop handle; the returned promise resolves when all loops drain.
 */
export function startWorkerLoops(): { stop: () => void; done: Promise<void> } {
  let running = true;
  const stop = () => {
    if (running) logger.info({ worker: WORKER_ID }, 'graceful shutdown requested');
    running = false;
  };

  const hbTimer = setInterval(() => heartbeat(WORKER_ID, runtime).catch(() => undefined), env.sync.heartbeatMs);

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

  // Periodic orchestration loop (scheduler + maintenance).
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

  const done = Promise.all([...runners, orchestrator()]).then(async () => {
    clearInterval(hbTimer);
    await markStopped(WORKER_ID).catch(() => undefined);
  });

  return { stop, done };
}

/**
 * Start the embedded worker inside the web process. Registers the worker and
 * runs the loops; the web process owns shutdown, so this never calls exit or
 * disconnects Prisma (the web server does that). Safe no-op guard for double
 * calls is the caller's responsibility.
 */
export async function startEmbeddedWorker(): Promise<{ stop: () => void; done: Promise<void> }> {
  await registerWorker(WORKER_ID);
  logger.info({ worker: WORKER_ID, concurrency: env.sync.concurrency }, 'embedded sync worker started (in web process)');
  return startWorkerLoops();
}

async function main(): Promise<void> {
  startHealthServer();
  await registerWorker(WORKER_ID);
  logger.info({ worker: WORKER_ID, concurrency: env.sync.concurrency }, 'sync worker started (durable queue)');

  const { stop, done } = startWorkerLoops();
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

  await done;
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
