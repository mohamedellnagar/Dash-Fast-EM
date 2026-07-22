import { prisma } from '../../db/prisma';
import { env } from '../../config/env';
import { logger } from '../../lib/logger';
import { JOB_STATUS, JOB_PRIORITY, TERMINAL_JOB_STATUSES, ErrorCategory } from '../../lib/enums';
import { metrics } from '../observability/metrics.service';
import { endpointConcurrency, getRateConfig, Endpoint, invalidateRateConfig } from './rate-limiter.service';
import { isFastTestFrozen, isConnectionTestDisabled } from '../fasttest/freeze';
import { canRequest } from './circuit-breaker.service';
import { decideRetry } from './retry';

const ACTIVE_STATUSES = [JOB_STATUS.QUEUED, JOB_STATUS.RUNNING, JOB_STATUS.RETRY_SCHEDULED];

// The claim path runs on every job for every runner (~20 concurrent). Several
// of its checks — "is sync allowed?" and "which subjects/workspaces are paused?"
// — change rarely but were re-queried on every claim, flooding the DB and
// starving the runner pool (slots sat empty while claims waited on DB). Cache
// these read-mostly control reads for a short TTL so claims stay cheap; an
// operator toggle takes effect within the TTL.
const CONTROL_TTL_MS = 2000;
function ttlCache<T>(fn: () => Promise<T>, ttlMs: number) {
  let value: T | undefined;
  let at = 0;
  let inflight: Promise<T> | null = null;
  return async (now: () => number = () => Date.now()): Promise<T> => {
    if (value !== undefined && now() - at < ttlMs) return value;
    if (inflight) return inflight;
    inflight = fn().then((v) => { value = v; at = now(); inflight = null; return v; }).catch((e) => { inflight = null; throw e; });
    return inflight;
  };
}

export interface EnqueueInput {
  jobType: string;
  priority?: number;
  workspaceId?: string | null;
  registrationId?: string | null;
  testCodeNormalized?: string | null;
  subject?: string | null;
  schoolId?: string | null;
  payload?: Record<string, unknown> | null;
  dedupeKey?: string | null;
  maxAttempts?: number;
  scheduledAt?: Date;
  createdBy?: string;
}

/**
 * Enqueue a job. If `dedupeKey` matches an existing ACTIVE job, the existing
 * job is returned instead of creating a duplicate (idempotent enqueue).
 * NOTE: payload must never contain secrets.
 */
export async function enqueue(input: EnqueueInput): Promise<{ job: any; deduped: boolean }> {
  const dedupeKey = input.dedupeKey ?? defaultDedupeKey(input);
  if (dedupeKey) {
    const existing = await prisma.syncJob.findFirst({ where: { dedupeKey, status: { in: ACTIVE_STATUSES } } });
    if (existing) return { job: existing, deduped: true };
  }
  const job = await prisma.syncJob.create({
    data: {
      jobType: input.jobType,
      priority: input.priority ?? JOB_PRIORITY[input.jobType] ?? 100,
      workspaceId: input.workspaceId ?? null,
      registrationId: input.registrationId ?? null,
      testCodeNormalized: input.testCodeNormalized ?? null,
      subject: input.subject ?? null,
      schoolId: input.schoolId ?? null,
      payload: input.payload ? JSON.stringify(input.payload) : null,
      dedupeKey,
      maxAttempts: input.maxAttempts ?? env.sync.maxRetries,
      scheduledAt: input.scheduledAt ?? new Date(),
      createdBy: input.createdBy ?? 'SYSTEM',
      status: JOB_STATUS.QUEUED,
    },
  });
  return { job, deduped: false };
}

function defaultDedupeKey(input: EnqueueInput): string | null {
  if (input.registrationId) return `${input.jobType}:${input.registrationId}`;
  if (input.workspaceId && input.jobType.includes('WORKSPACE')) return `${input.jobType}:${input.workspaceId}`;
  return null;
}

const endpointForJobType: Record<string, Endpoint> = {
  AUTHENTICATE_WORKSPACE: 'auth',
  SYNC_REGISTRATION_STATUS: 'status',
  SYNC_REGISTRATION_RESULTS: 'results',
  SYNC_REGISTRATION_FULL: 'status',
  MANUAL_SYNC: 'status',
};

async function pausedSetsUncached() {
  const controls = await prisma.queueControl.findMany({ where: { paused: true } });
  const workspaces = new Set(controls.filter((c) => c.scope === 'WORKSPACE').map((c) => c.scopeKey));
  const jobTypes = new Set(controls.filter((c) => c.scope === 'JOB_TYPE').map((c) => c.scopeKey));
  return { workspaces, jobTypes };
}
const pausedSets = ttlCache(pausedSetsUncached, CONTROL_TTL_MS);

/**
 * Atomically claim the next runnable job for a worker. Respects: paused
 * workspaces/job-types, per-workspace concurrency (distributed via RUNNING
 * count), global concurrency ceiling, and open circuit breakers. Uses a guarded
 * updateMany so only one worker can win a given job. Fair across workspaces.
 */
export async function claimNext(workerId: string, now: () => number = () => Date.now()): Promise<any | null> {
  const nowDate = new Date(now());

  // Global on/off switch + time-window: when sync isn't allowed, claim nothing.
  if (!(await syncAllowedNow(now))) return null;

  // Global concurrency ceiling.
  const globalRunning = await prisma.syncJob.count({ where: { status: JOB_STATUS.RUNNING } });
  if (globalRunning >= env.sync.globalMaxConcurrent) return null;

  const { workspaces: pausedWs, jobTypes: pausedJt } = await pausedSets();

  // Fetch a wider window of due jobs than one worker needs. With ~20 workers all
  // claiming at once, a narrow window makes them all fight over the same top
  // rows — the guarded update serializes and InnoDB deadlocks. A wider pool +
  // per-worker random ordering spreads the contention so each worker targets a
  // different row first.
  const candidates = await prisma.syncJob.findMany({
    where: {
      OR: [
        { status: JOB_STATUS.QUEUED, scheduledAt: { lte: nowDate } },
        { status: JOB_STATUS.RETRY_SCHEDULED, nextRetryAt: { lte: nowDate } },
      ],
    },
    orderBy: [{ priority: 'asc' }, { scheduledAt: 'asc' }],
    take: 200,
  });
  if (candidates.length === 0) return null;
  // Shuffle so concurrent workers don't all attempt the same head-of-queue row.
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }

  // Per-workspace RUNNING counts for fairness + concurrency enforcement.
  const runningByWs = new Map<string, number>();
  const grouped = await prisma.syncJob.groupBy({ by: ['workspaceId'], where: { status: JOB_STATUS.RUNNING }, _count: { _all: true } });
  for (const g of grouped) runningByWs.set(g.workspaceId ?? '_', g._count._all);

  // Prefer workspaces with fewer running jobs (fair scheduling).
  const eligible = candidates
    .filter((c) => !pausedJt.has(c.jobType))
    .filter((c) => !(c.workspaceId && pausedWs.has(c.workspaceId)))
    .sort((a, b) => (runningByWs.get(a.workspaceId ?? '_') ?? 0) - (runningByWs.get(b.workspaceId ?? '_') ?? 0));

  for (const cand of eligible) {
    if (cand.workspaceId) {
      // Circuit breaker gate.
      const cb = await canRequest(cand.workspaceId, now);
      if (!cb.allowed) continue;
      // Per-workspace / per-endpoint concurrency.
      const cfg = await getRateConfig(cand.workspaceId, now);
      const cap = endpointConcurrency(cfg, endpointForJobType[cand.jobType] ?? 'other');
      const running = runningByWs.get(cand.workspaceId) ?? 0;
      if (running >= cap) continue;
    }
    // Atomic claim.
    const claim = await prisma.syncJob.updateMany({
      where: { id: cand.id, status: cand.status, lockedBy: null },
      data: {
        status: JOB_STATUS.RUNNING, lockedBy: workerId, lockedAt: nowDate, heartbeatAt: nowDate,
        startedAt: nowDate, attemptCount: { increment: 1 },
      },
    });
    if (claim.count === 1) {
      runningByWs.set(cand.workspaceId ?? '_', (runningByWs.get(cand.workspaceId ?? '_') ?? 0) + 1);
      return prisma.syncJob.findUnique({ where: { id: cand.id } });
    }
  }
  return null;
}

export async function heartbeatJob(jobId: string, workerId: string): Promise<void> {
  await prisma.syncJob.updateMany({ where: { id: jobId, lockedBy: workerId }, data: { heartbeatAt: new Date() } });
}

export async function completeJob(job: any, workerId: string, durationMs: number, endpoint?: string): Promise<void> {
  await prisma.$transaction([
    prisma.syncJob.update({
      where: { id: job.id },
      data: { status: JOB_STATUS.DONE, completedAt: new Date(), lockedBy: null, lockedAt: null, lastErrorCode: null, lastErrorMessage: null },
    }),
    prisma.syncJobAttempt.create({
      data: { jobId: job.id, attemptNumber: job.attemptCount, workerId, endpoint: endpoint ?? null, status: 'SUCCESS', durationMs, correlationId: job.correlationId },
    }),
  ]);
  metrics.jobsTotal.inc({ type: job.jobType, outcome: 'done' });
  metrics.jobDuration.set(durationMs, { type: job.jobType });
}

/** Record a failed attempt and schedule retry / dead-letter / manual review. */
export async function failJob(
  job: any,
  workerId: string,
  err: { category: ErrorCategory; code?: string; message?: string; httpStatus?: number; retryAfterMs?: number },
  durationMs: number,
  endpoint?: string,
  now: () => number = () => Date.now(),
): Promise<{ action: string }> {
  const decision = decideRetry(err.category, job.attemptCount, job.maxAttempts, { retryAfterMs: err.retryAfterMs });
  const base = {
    lockedBy: null, lockedAt: null,
    lastErrorCode: err.category, lastErrorMessage: (err.message ?? '').slice(0, 500),
  };
  let statusUpdate: any;
  if (decision.action === 'RETRY') {
    statusUpdate = { ...base, status: JOB_STATUS.RETRY_SCHEDULED, nextRetryAt: new Date(now() + decision.delayMs) };
    metrics.jobsRetried.inc({ type: job.jobType });
  } else if (decision.action === 'MANUAL_REVIEW') {
    statusUpdate = { ...base, status: JOB_STATUS.MANUAL_REVIEW, completedAt: new Date() };
  } else {
    statusUpdate = { ...base, status: JOB_STATUS.DEAD_LETTER, completedAt: new Date() };
  }

  await prisma.$transaction([
    prisma.syncJob.update({ where: { id: job.id }, data: statusUpdate }),
    prisma.syncJobAttempt.create({
      data: {
        jobId: job.id, attemptNumber: job.attemptCount, workerId, endpoint: endpoint ?? null, status: 'FAILURE',
        errorCategory: err.category, errorCode: err.code ?? null, errorMessage: (err.message ?? '').slice(0, 500),
        httpStatus: err.httpStatus ?? null, durationMs, correlationId: job.correlationId,
      },
    }),
  ]);
  metrics.jobsFailed.inc({ type: job.jobType, category: err.category });
  metrics.jobsTotal.inc({ type: job.jobType, outcome: decision.action.toLowerCase() });
  return { action: decision.action };
}

export async function cancelJob(jobId: string): Promise<boolean> {
  const job = await prisma.syncJob.findUnique({ where: { id: jobId } });
  if (!job || (TERMINAL_JOB_STATUSES as string[]).includes(job.status)) return false;
  await prisma.syncJob.update({ where: { id: jobId }, data: { status: JOB_STATUS.CANCELLED, completedAt: new Date(), lockedBy: null } });
  return true;
}

export async function retryJob(jobId: string): Promise<boolean> {
  const job = await prisma.syncJob.findUnique({ where: { id: jobId } });
  if (!job) return false;
  await prisma.syncJob.update({
    where: { id: jobId },
    data: { status: JOB_STATUS.QUEUED, attemptCount: 0, nextRetryAt: null, scheduledAt: new Date(), lockedBy: null, lockedAt: null, completedAt: null },
  });
  return true;
}

/** Move a dead-letter job back to the queue. */
export async function requeueDeadLetter(jobId: string): Promise<boolean> {
  const job = await prisma.syncJob.findFirst({ where: { id: jobId, status: JOB_STATUS.DEAD_LETTER } });
  if (!job) return false;
  return retryJob(jobId);
}

export async function retryFailedJobs(filter: { workspaceId?: string; jobType?: string } = {}): Promise<number> {
  const where: any = { status: { in: [JOB_STATUS.FAILED, JOB_STATUS.DEAD_LETTER] } };
  if (filter.workspaceId) where.workspaceId = filter.workspaceId;
  if (filter.jobType) where.jobType = filter.jobType;
  const res = await prisma.syncJob.updateMany({
    where,
    data: { status: JOB_STATUS.QUEUED, attemptCount: 0, nextRetryAt: null, scheduledAt: new Date(), lockedBy: null, lockedAt: null },
  });
  return res.count;
}

/** Recover stalled RUNNING jobs whose worker heartbeat has expired. */
export async function recoverStalledJobs(now: () => number = () => Date.now()): Promise<number> {
  const cutoff = new Date(now() - env.sync.stalledJobMs);
  const res = await prisma.syncJob.updateMany({
    where: { status: JOB_STATUS.RUNNING, OR: [{ heartbeatAt: { lt: cutoff } }, { heartbeatAt: null, lockedAt: { lt: cutoff } }] },
    data: { status: JOB_STATUS.RETRY_SCHEDULED, nextRetryAt: new Date(now()), lockedBy: null, lockedAt: null, lastErrorCode: 'STALLED', lastErrorMessage: 'Worker heartbeat expired; job reclaimed' },
  });
  if (res.count > 0) logger.warn({ recovered: res.count }, 'recovered stalled jobs');
  return res.count;
}

// --- pause / resume controls ---
export async function pauseWorkspace(workspaceId: string, paused: boolean, by?: string): Promise<void> {
  await prisma.$transaction([
    prisma.queueControl.upsert({
      where: { scope_scopeKey: { scope: 'WORKSPACE', scopeKey: workspaceId } },
      create: { scope: 'WORKSPACE', scopeKey: workspaceId, paused, updatedBy: by },
      update: { paused, updatedBy: by },
    }),
    prisma.fastTestWorkspace.update({ where: { id: workspaceId }, data: { syncPaused: paused } }),
  ]);
}

export async function pauseJobType(jobType: string, paused: boolean, by?: string): Promise<void> {
  await prisma.queueControl.upsert({
    where: { scope_scopeKey: { scope: 'JOB_TYPE', scopeKey: jobType } },
    create: { scope: 'JOB_TYPE', scopeKey: jobType, paused, updatedBy: by },
    update: { paused, updatedBy: by },
  });
}

// --- fast (turbo) sync mode ---
// One switch flips ALL active workspaces between a conservative NORMAL profile
// and a high-throughput FAST profile. The two are mutually exclusive: enabling
// FAST replaces the NORMAL rate limits, disabling it restores them.

const RATE_PROFILES = {
  NORMAL: { maxRps: 8, maxRpm: 300, maxConcurrent: 10, maxBatch: 50, minDelayMs: 50, burst: 15, cooldownMs: 30000 },
  FAST: { maxRps: 40, maxRpm: 2400, maxConcurrent: 40, maxBatch: 100, minDelayMs: 10, burst: 40, cooldownMs: 15000 },
};
const FAST_MODE_KEY = 'sync.fastMode';

/**
 * Switch the sync Mode (Normal ↔ FAST). Mode is the single operator knob: it
 * sets the auto-tuner's ceiling and climb rate. Flipping it also turns auto-tune
 * ON for every active workspace and seeds a sane starting rpm, so the system
 * takes over management of rpm/concurrency/rps/min-delay from that point — the
 * operator never has to touch per-workspace numbers.
 */
export async function setFastMode(enabled: boolean, by?: string): Promise<void> {
  await prisma.systemSetting.upsert({
    where: { key: FAST_MODE_KEY },
    create: { key: FAST_MODE_KEY, value: enabled ? 'true' : 'false' },
    update: { value: enabled ? 'true' : 'false' },
  });
  // Hand every active workspace to the auto-tuner with a healthy seed so it
  // climbs from a useful floor rather than the conservative default.
  const seedRpm = enabled ? 600 : 200;
  const seed = { maxRpm: seedRpm, maxRps: Math.ceil(seedRpm / 30), maxConcurrent: Math.max(6, Math.ceil(seedRpm / 60)), minDelayMs: Math.max(5, Math.floor(60000 / seedRpm)) };
  const workspaces = await prisma.fastTestWorkspace.findMany({ where: { isActive: true, deletedAt: null }, select: { id: true } });
  for (const ws of workspaces) {
    await prisma.workspaceRateLimit.upsert({
      where: { workspaceId: ws.id },
      create: { workspaceId: ws.id, autoTune: true, ...seed },
      update: { autoTune: true },
    });
    invalidateRateConfig(ws.id);
  }
  void by;
}

/** The default rate profile for workspaces without a manual override. */
export function fastModeProfile(enabled: boolean) {
  return enabled ? RATE_PROFILES.FAST : RATE_PROFILES.NORMAL;
}

export async function isFastMode(): Promise<boolean> {
  const row = await prisma.systemSetting.findUnique({ where: { key: FAST_MODE_KEY } });
  return row?.value === 'true';
}

// --- Sync strategy: ADAPTIVE (per-status intervals + backoff) vs SWEEP
// (continuous round-robin over every non-terminal code, oldest-checked first). ---
export type SyncMode = 'ADAPTIVE' | 'SWEEP';
const SYNC_MODE_KEY = 'sync.mode';

export async function getSyncMode(): Promise<SyncMode> {
  const row = await prisma.systemSetting.findUnique({ where: { key: SYNC_MODE_KEY } });
  return row?.value === 'SWEEP' ? 'SWEEP' : 'ADAPTIVE';
}

export async function setSyncMode(mode: SyncMode, by?: string): Promise<void> {
  await prisma.systemSetting.upsert({
    where: { key: SYNC_MODE_KEY },
    create: { key: SYNC_MODE_KEY, value: mode },
    update: { value: mode },
  });
  void by;
}

// --- per-subject (ExamSubject) sync control ---

/** Enable/disable sync for a whole ExamSubject. */
export async function pauseSubject(examSubject: string, paused: boolean, by?: string): Promise<void> {
  await prisma.queueControl.upsert({
    where: { scope_scopeKey: { scope: 'SUBJECT', scopeKey: examSubject } },
    create: { scope: 'SUBJECT', scopeKey: examSubject, paused, updatedBy: by },
    update: { paused, updatedBy: by },
  });
}

/** ExamSubjects currently paused (excluded from scheduling). */
export async function pausedSubjects(): Promise<string[]> {
  const rows = await prisma.queueControl.findMany({ where: { scope: 'SUBJECT', paused: true } });
  return rows.map((r) => r.scopeKey);
}

/** All distinct ExamSubjects with their sync-enabled state + registration count (for UI). */
export async function getSubjectSyncControls(): Promise<Array<{ examSubject: string; total: number; paused: boolean }>> {
  const [groups, controls] = await Promise.all([
    prisma.examRegistration.groupBy({ by: ['examSubject'], where: { deletedAt: null }, _count: { _all: true } }),
    prisma.queueControl.findMany({ where: { scope: 'SUBJECT' } }),
  ]);
  const pausedSet = new Set(controls.filter((c) => c.paused).map((c) => c.scopeKey));
  return groups
    .map((g) => ({ examSubject: g.examSubject, total: g._count._all, paused: pausedSet.has(g.examSubject) }))
    .sort((a, b) => b.total - a.total);
}

// --- per-academic-year sync control ---

/** Enable/disable sync for a whole academic year. */
export async function pauseAcademicYear(academicYear: string, paused: boolean, by?: string): Promise<void> {
  await prisma.queueControl.upsert({
    where: { scope_scopeKey: { scope: 'ACADEMIC_YEAR', scopeKey: academicYear } },
    create: { scope: 'ACADEMIC_YEAR', scopeKey: academicYear, paused, updatedBy: by },
    update: { paused, updatedBy: by },
  });
}

/** Academic years currently paused (excluded from scheduling). */
export async function pausedAcademicYears(): Promise<string[]> {
  const rows = await prisma.queueControl.findMany({ where: { scope: 'ACADEMIC_YEAR', paused: true } });
  return rows.map((r) => r.scopeKey);
}

/** All academic years with registration count + sync-enabled state (for UI). */
export async function getAcademicYearSyncControls(): Promise<Array<{ academicYear: string; total: number; paused: boolean }>> {
  const [groups, controls] = await Promise.all([
    prisma.examRegistration.groupBy({ by: ['academicYear'], where: { deletedAt: null, academicYear: { not: null } }, _count: { _all: true } }),
    prisma.queueControl.findMany({ where: { scope: 'ACADEMIC_YEAR' } }),
  ]);
  const pausedSet = new Set(controls.filter((c) => c.paused).map((c) => c.scopeKey));
  return groups
    .filter((g) => g.academicYear)
    .map((g) => ({ academicYear: g.academicYear as string, total: g._count._all, paused: pausedSet.has(g.academicYear as string) }))
    .sort((a, b) => b.academicYear.localeCompare(a.academicYear));
}

// --- global on/off + time-window scheduling ---

const GLOBAL_KEY = { scope: 'GLOBAL', scopeKey: 'ALL' };
const WINDOW_START_KEY = 'sync.window.startHour';
const WINDOW_END_KEY = 'sync.window.endHour';

/** Turn the whole sync engine on/off at runtime (no restart needed). */
export async function pauseGlobal(paused: boolean, by?: string): Promise<void> {
  await prisma.queueControl.upsert({
    where: { scope_scopeKey: GLOBAL_KEY },
    create: { ...GLOBAL_KEY, paused, updatedBy: by },
    update: { paused, updatedBy: by },
  });
}

/**
 * Restrict sync to a daily time window [startHour, endHour) in server local
 * time (0-23). Pass null/null to clear the window (sync always allowed).
 * A window where start > end wraps past midnight (e.g. 22 → 6).
 */
export async function setSyncWindow(startHour: number | null, endHour: number | null, by?: string): Promise<void> {
  const start = startHour == null ? '' : String(startHour);
  const end = endHour == null ? '' : String(endHour);
  await prisma.$transaction([
    prisma.systemSetting.upsert({ where: { key: WINDOW_START_KEY }, create: { key: WINDOW_START_KEY, value: start }, update: { value: start } }),
    prisma.systemSetting.upsert({ where: { key: WINDOW_END_KEY }, create: { key: WINDOW_END_KEY, value: end }, update: { value: end } }),
  ]);
  void by;
}

/** Whether sync is allowed to run right now (master freeze + global switch + window). */
// DB-derived part of the allowed check (frozen switch, global pause, window
// bounds). Cached with a short TTL because it's read on every job claim; the
// hour comparison below is recomputed fresh each call (cheap, no DB).
const allowedState = ttlCache(async () => {
  const [frozen, global, rows] = await Promise.all([
    isFastTestFrozen(),
    prisma.queueControl.findFirst({ where: { scope: 'GLOBAL', paused: true } }),
    prisma.systemSetting.findMany({ where: { key: { in: [WINDOW_START_KEY, WINDOW_END_KEY] } } }),
  ]);
  const map = new Map(rows.map((r) => [r.key, r.value]));
  return { frozen, globalPaused: !!global, start: Number(map.get(WINDOW_START_KEY)), end: Number(map.get(WINDOW_END_KEY)) };
}, CONTROL_TTL_MS);

export async function syncAllowedNow(now: () => number = () => Date.now()): Promise<boolean> {
  const st = await allowedState(now);
  if (st.frozen || st.globalPaused) return false;
  if (Number.isNaN(st.start) || Number.isNaN(st.end)) return true; // no window → always allowed
  const hour = hourInTimezone(now(), env.timezone);
  return st.start <= st.end ? hour >= st.start && hour < st.end : hour >= st.start || hour < st.end;
}

/** Current hour (0-23) in a given IANA timezone, independent of the server clock. */
export function hourInTimezone(ms: number, timeZone: string): number {
  try {
    const h = new Intl.DateTimeFormat('en-US', { timeZone, hour: '2-digit', hour12: false }).format(new Date(ms));
    const n = Number(h === '24' ? '0' : h); // some ICU builds emit "24" for midnight
    return Number.isNaN(n) ? new Date(ms).getHours() : n;
  } catch {
    return new Date(ms).getHours(); // invalid TZ → fall back to server local
  }
}

/** Current control state for UI/status. */
export async function getSyncControlState(): Promise<{ globalPaused: boolean; windowStart: number | null; windowEnd: number | null; allowedNow: boolean; fastMode: boolean; frozen: boolean; connectionTestDisabled: boolean; syncMode: SyncMode; timezone: string; currentHour: number }> {
  const [global, rows, allowedNow, fastMode, frozen, connectionTestDisabled, syncMode] = await Promise.all([
    prisma.queueControl.findFirst({ where: { scope: 'GLOBAL', scopeKey: 'ALL' } }),
    prisma.systemSetting.findMany({ where: { key: { in: [WINDOW_START_KEY, WINDOW_END_KEY] } } }),
    syncAllowedNow(),
    isFastMode(),
    isFastTestFrozen(),
    isConnectionTestDisabled(),
    getSyncMode(),
  ]);
  const map = new Map(rows.map((r) => [r.key, r.value]));
  const parse = (v?: string) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
  return {
    globalPaused: !!global?.paused,
    windowStart: parse(map.get(WINDOW_START_KEY)),
    windowEnd: parse(map.get(WINDOW_END_KEY)),
    allowedNow,
    fastMode,
    frozen,
    connectionTestDisabled,
    syncMode,
    timezone: env.timezone,
    currentHour: hourInTimezone(Date.now(), env.timezone),
  };
}

// --- queue statistics ---
export async function queueStats(now: () => number = () => Date.now()) {
  const [byStatus, oldest, jobsLastMin, failedLastMin, byType, byWs, byPriority] = await Promise.all([
    prisma.syncJob.groupBy({ by: ['status'], _count: { _all: true } }),
    prisma.syncJob.findFirst({ where: { status: JOB_STATUS.QUEUED }, orderBy: { scheduledAt: 'asc' }, select: { scheduledAt: true } }),
    prisma.syncJobAttempt.count({ where: { startedAt: { gte: new Date(now() - 60000) } } }),
    prisma.syncJobAttempt.count({ where: { startedAt: { gte: new Date(now() - 60000) }, status: 'FAILURE' } }),
    prisma.syncJob.groupBy({ by: ['jobType'], _count: { _all: true } }),
    prisma.syncJob.groupBy({ by: ['workspaceId'], where: { status: { in: ACTIVE_STATUSES } }, _count: { _all: true } }),
    prisma.syncJob.groupBy({ by: ['priority'], where: { status: { in: ACTIVE_STATUSES } }, _count: { _all: true } }),
  ]);
  const counts: Record<string, number> = {};
  for (const g of byStatus) counts[g.status] = g._count._all;
  const oldestAgeMs = oldest ? now() - oldest.scheduledAt.getTime() : 0;
  return {
    counts,
    queued: counts.QUEUED ?? 0,
    running: counts.RUNNING ?? 0,
    completed: counts.DONE ?? 0,
    failed: counts.FAILED ?? 0,
    retryScheduled: counts.RETRY_SCHEDULED ?? 0,
    deadLetter: counts.DEAD_LETTER ?? 0,
    oldestQueuedAgeMs: oldestAgeMs,
    jobsLastMin, failedLastMin,
    byType: byType.map((t) => ({ jobType: t.jobType, count: t._count._all })),
    byWorkspace: byWs.map((w) => ({ workspaceId: w.workspaceId, count: w._count._all })),
    byPriority: byPriority.map((p) => ({ priority: p.priority, count: p._count._all })),
  };
}
