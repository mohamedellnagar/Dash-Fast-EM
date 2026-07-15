import { prisma } from '../../db/prisma';
import { logger } from '../../lib/logger';
import { JOB_TYPE, SYNC_STATE, DASHBOARD_STATUS, ERROR_CATEGORY, ErrorCategory } from '../../lib/enums';
import { FastTestApiError, FastTestClient, fastTestClient } from '../fasttest/client';
import { getWorkspaceById, resolveWorkspaceBySubject, ResolvedWorkspace } from '../workspace.service';
import { refreshAttention } from '../attention.service';
import { invalidate, CACHE_KEYS } from '../observability/cache.service';
import { fetchAndPersistStatus, fetchAndPersistResults } from './sync.service';
import { transitionState } from './state';
import { classify } from './error-classifier';
import { acquireSlot } from './rate-limiter.service';
import { currentThrottle } from './adaptive.service';
import { recordSuccess, recordFailure } from './circuit-breaker.service';
import { computeScheduling } from './scheduler.service';
import { enqueue, retryFailedJobs } from './queue.service';
import { shouldFetchResults } from './policy';

export type JobOutcome =
  | { kind: 'DONE' }
  | { kind: 'FAIL'; category: ErrorCategory; code?: string; message?: string; httpStatus?: number; retryAfterMs?: number; endpoint?: string }
  | { kind: 'RESCHEDULE'; delayMs: number };

async function resolveWs(job: any): Promise<ResolvedWorkspace | null> {
  if (job.workspaceId) {
    const ws = await getWorkspaceById(job.workspaceId);
    if (ws) return ws;
  }
  if (job.subject) return resolveWorkspaceBySubject(job.subject);
  return null;
}

/** Acquire a workspace rate slot honoring adaptive throttle. */
async function gate(workspaceId: string): Promise<{ ok: true } | { ok: false; delayMs: number }> {
  const throttle = await currentThrottle(workspaceId);
  const slot = await acquireSlot(workspaceId, throttle);
  return slot.allowed ? { ok: true } : { ok: false, delayMs: Math.max(250, slot.retryAfterMs) };
}

function classifyFromError(e: unknown, endpoint: string): JobOutcome {
  if (e instanceof FastTestApiError) {
    const c = classify({ errorType: e.errorType, httpStatus: e.httpStatus, code: e.fastTestErrorCode, message: e.message });
    return { kind: 'FAIL', category: c.category, code: e.fastTestErrorCode, message: e.message, httpStatus: e.httpStatus, endpoint };
  }
  return { kind: 'FAIL', category: ERROR_CATEGORY.DATABASE, message: (e as Error).message, endpoint };
}

const errorStateFor: Record<string, string> = {
  AUTHENTICATION: SYNC_STATE.AUTH_FAILED,
  TOKEN_EXPIRED: SYNC_STATE.AUTH_FAILED,
  NOT_FOUND: SYNC_STATE.NOT_FOUND,
  RATE_LIMIT: SYNC_STATE.RATE_LIMITED,
  TIMEOUT: SYNC_STATE.TIMEOUT,
};

async function handleStatus(job: any, ws: ResolvedWorkspace, client: FastTestClient): Promise<JobOutcome> {
  const reg = await prisma.examRegistration.findUnique({ where: { id: job.registrationId } });
  if (!reg) return { kind: 'FAIL', category: ERROR_CATEGORY.NOT_FOUND, message: 'registration missing' };

  const g = await gate(ws.workspaceId);
  if (!g.ok) return { kind: 'RESCHEDULE', delayMs: g.delayMs };

  // Enter QUEUED (bridge from any rest-state) then SYNCING_STATUS.
  await transitionState(reg.id, SYNC_STATE.QUEUED, { jobId: job.id, correlationId: job.correlationId });
  await transitionState(reg.id, SYNC_STATE.SYNCING_STATUS, { jobId: job.id, correlationId: job.correlationId });
  try {
    const { dashboardStatus } = await fetchAndPersistStatus(reg, ws, client);
    await recordSuccess(ws.workspaceId);
    await transitionState(reg.id, SYNC_STATE.STATUS_SYNCED, { jobId: job.id });

    // Recompute scheduling from the fresh status.
    const hasResults = (await prisma.fastTestResult.count({ where: { registrationId: reg.id } })) > 0;
    const sched = computeScheduling({ ...reg, dashboardStatus, hasResults }, Date.now());
    await prisma.examRegistration.update({
      where: { id: reg.id },
      data: { nextSyncAt: sched.nextSyncAt, syncPriority: sched.syncPriority, isStale: sched.isStale, staleReason: sched.staleReason, staleSeverity: sched.staleSeverity },
    });

    // Enqueue a results job when needed and not already present.
    if (shouldFetchResults(dashboardStatus) && !hasResults) {
      await enqueue({ jobType: JOB_TYPE.SYNC_REGISTRATION_RESULTS, workspaceId: ws.workspaceId, registrationId: reg.id, subject: reg.examName, schoolId: reg.schoolId, testCodeNormalized: reg.testCodeNormalized });
    } else if (dashboardStatus === DASHBOARD_STATUS.COMPLETED) {
      await transitionState(reg.id, SYNC_STATE.COMPLETED, { jobId: job.id });
    }
    invalidate(CACHE_KEYS.ANALYTICS);
    return { kind: 'DONE' };
  } catch (e) {
    const outcome = classifyFromError(e, '/tests/registration/{code}/status');
    if (outcome.kind === 'FAIL') {
      await recordFailure(ws.workspaceId, outcome.category);
      await transitionState(reg.id, errorStateFor[outcome.category] ?? SYNC_STATE.API_ERROR, { jobId: job.id, reason: outcome.message });
    }
    return outcome;
  }
}

async function handleResults(job: any, ws: ResolvedWorkspace, client: FastTestClient): Promise<JobOutcome> {
  const reg = await prisma.examRegistration.findUnique({ where: { id: job.registrationId } });
  if (!reg) return { kind: 'FAIL', category: ERROR_CATEGORY.NOT_FOUND, message: 'registration missing' };

  const g = await gate(ws.workspaceId);
  if (!g.ok) return { kind: 'RESCHEDULE', delayMs: g.delayMs };

  // Bridge to QUEUED then SYNCING_RESULTS so the transition is valid from any rest-state.
  await transitionState(reg.id, SYNC_STATE.QUEUED, { jobId: job.id, correlationId: job.correlationId });
  await transitionState(reg.id, SYNC_STATE.SYNCING_RESULTS, { jobId: job.id, correlationId: job.correlationId });
  try {
    await fetchAndPersistResults(reg, ws, client);
    await recordSuccess(ws.workspaceId);
    await transitionState(reg.id, SYNC_STATE.RESULTS_SYNCED, { jobId: job.id });
    if (reg.dashboardStatus === DASHBOARD_STATUS.COMPLETED) {
      await transitionState(reg.id, SYNC_STATE.COMPLETED, { jobId: job.id });
      // Completed + results now stored → terminal. Push nextSyncAt far out so
      // the scheduler never re-syncs this registration again.
      const sched = computeScheduling({ ...reg, hasResults: true }, Date.now());
      await prisma.examRegistration.update({
        where: { id: reg.id },
        data: { nextSyncAt: sched.nextSyncAt, isStale: false, staleReason: null, staleSeverity: null, staleSince: null },
      });
    }
    invalidate(CACHE_KEYS.ANALYTICS);
    return { kind: 'DONE' };
  } catch (e) {
    const outcome = classifyFromError(e, '/tests/registration/{code}/results');
    if (outcome.kind === 'FAIL') {
      await recordFailure(ws.workspaceId, outcome.category);
      await transitionState(reg.id, errorStateFor[outcome.category] ?? SYNC_STATE.API_ERROR, { jobId: job.id, reason: outcome.message });
    }
    return outcome;
  }
}

async function handleFull(job: any, ws: ResolvedWorkspace, client: FastTestClient): Promise<JobOutcome> {
  const statusOutcome = await handleStatus(job, ws, client);
  if (statusOutcome.kind !== 'DONE') return statusOutcome;
  const reg = await prisma.examRegistration.findUnique({ where: { id: job.registrationId } });
  if (reg && shouldFetchResults(reg.dashboardStatus)) return handleResults(job, ws, client);
  return { kind: 'DONE' };
}

async function handleAuthenticate(job: any, ws: ResolvedWorkspace, client: FastTestClient): Promise<JobOutcome> {
  try {
    await client.authenticate(ws);
    await recordSuccess(ws.workspaceId);
    return { kind: 'DONE' };
  } catch (e) {
    const outcome = classifyFromError(e, '/auth/simple');
    if (outcome.kind === 'FAIL') await recordFailure(ws.workspaceId, outcome.category);
    return outcome;
  }
}

// Batch jobs fan out child status jobs (no direct API call).
async function enqueueBatch(where: any, extra: Partial<{ subject: string }> = {}): Promise<number> {
  const regs = await prisma.examRegistration.findMany({
    where: { deletedAt: null, ...where },
    select: { id: true, workspaceId: true, examName: true, schoolId: true, testCodeNormalized: true },
    take: 2000,
  });
  let n = 0;
  for (const r of regs) {
    if (!r.workspaceId) continue;
    const res = await enqueue({ jobType: JOB_TYPE.SYNC_REGISTRATION_STATUS, workspaceId: r.workspaceId, registrationId: r.id, subject: r.examName, schoolId: r.schoolId, testCodeNormalized: r.testCodeNormalized, ...extra });
    if (!res.deduped) n++;
  }
  return n;
}

/** Execute a claimed job. Returns an outcome the worker uses to finalize it. */
export async function runJob(job: any, client: FastTestClient = fastTestClient): Promise<JobOutcome> {
  switch (job.jobType) {
    case JOB_TYPE.AUTHENTICATE_WORKSPACE: {
      const ws = await resolveWs(job);
      if (!ws) return { kind: 'FAIL', category: ERROR_CATEGORY.WORKSPACE_MISMATCH, message: 'workspace not found' };
      return handleAuthenticate(job, ws, client);
    }
    case JOB_TYPE.SYNC_REGISTRATION_STATUS:
    case JOB_TYPE.MANUAL_SYNC: {
      const ws = await resolveWs(job);
      if (!ws) return { kind: 'FAIL', category: ERROR_CATEGORY.WORKSPACE_MISMATCH, message: 'workspace not found' };
      return job.jobType === JOB_TYPE.MANUAL_SYNC ? handleFull(job, ws, client) : handleStatus(job, ws, client);
    }
    case JOB_TYPE.SYNC_REGISTRATION_RESULTS: {
      const ws = await resolveWs(job);
      if (!ws) return { kind: 'FAIL', category: ERROR_CATEGORY.WORKSPACE_MISMATCH, message: 'workspace not found' };
      return handleResults(job, ws, client);
    }
    case JOB_TYPE.SYNC_REGISTRATION_FULL: {
      const ws = await resolveWs(job);
      if (!ws) return { kind: 'FAIL', category: ERROR_CATEGORY.WORKSPACE_MISMATCH, message: 'workspace not found' };
      return handleFull(job, ws, client);
    }
    case JOB_TYPE.SYNC_WORKSPACE_BATCH: {
      await enqueueBatch({ workspaceId: job.workspaceId });
      return { kind: 'DONE' };
    }
    case JOB_TYPE.SYNC_SCHOOL_BATCH: {
      await enqueueBatch({ schoolId: job.schoolId });
      return { kind: 'DONE' };
    }
    case JOB_TYPE.SYNC_SUBJECT_BATCH: {
      await enqueueBatch({ examSubject: job.subject });
      return { kind: 'DONE' };
    }
    case JOB_TYPE.SYNC_ACTIVE_EXAMS: {
      // Registrations whose exam window is open now (best-effort on string dates).
      const nowIso = new Date().toISOString().slice(0, 10);
      await enqueueBatch({ startDate: { lte: nowIso }, endDate: { gte: nowIso } });
      return { kind: 'DONE' };
    }
    case JOB_TYPE.REFRESH_ATTENTION_ITEMS: {
      await refreshAttention();
      return { kind: 'DONE' };
    }
    case JOB_TYPE.REFRESH_ANALYTICS_CACHE: {
      invalidate();
      return { kind: 'DONE' };
    }
    case JOB_TYPE.RETRY_FAILED_SYNC: {
      await retryFailedJobs({ workspaceId: job.workspaceId ?? undefined });
      return { kind: 'DONE' };
    }
    default:
      logger.warn({ jobType: job.jobType }, 'unknown job type');
      return { kind: 'FAIL', category: ERROR_CATEGORY.QUEUE, message: `unknown job type ${job.jobType}` };
  }
}
