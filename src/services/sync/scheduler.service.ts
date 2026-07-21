import { prisma } from '../../db/prisma';
import { retryOnDeadlock } from '../../db/retry';
import { env } from '../../config/env';
import { DASHBOARD_STATUS, JOB_TYPE, JOB_PRIORITY } from '../../lib/enums';
import { nextSyncDelaySeconds, shouldFetchResults } from './policy';
import { enqueue, syncAllowedNow, pausedSubjects, pausedAcademicYears, getSyncMode } from './queue.service';

export interface Scheduling {
  nextSyncAt: Date;
  syncPriority: number;
  isActiveExamWindow: boolean;
  requiresStatusFetch: boolean;
  requiresResultsFetch: boolean;
  isStale: boolean;
  staleReason: string | null;
  staleSeverity: 'LOW' | 'MEDIUM' | 'HIGH' | null;
}

interface RegForSchedule {
  id: string;
  dashboardStatus: string;
  startDate: string | null;
  endDate: string | null;
  lastSuccessfulSyncAt: Date | null;
  nextSyncAt: Date | null;
  hasResults: boolean;
  unchangedPolls?: number;
}

export function isActiveExamWindow(reg: { startDate: string | null; endDate: string | null }, nowMs: number): boolean {
  const start = reg.startDate ? Date.parse(reg.startDate) : NaN;
  const end = reg.endDate ? Date.parse(reg.endDate) : NaN;
  if (Number.isNaN(start) || Number.isNaN(end)) return false;
  return nowMs >= start && nowMs <= end;
}

const PRIORITY_BY_STATUS: Record<string, number> = {
  IN_PROGRESS: 30,
  NOT_SYNCED: 40, // first-ever sync — must beat routine re-polls, else it starves
  UNDER_REVIEW: 50,
  NOT_STARTED: 55,
  REVIEW_FAILED: 60,
  UNKNOWN: 65,
  COMPLETED: 90,
};

/** Compute scheduling + stale metadata for a registration. */
export function computeScheduling(reg: RegForSchedule, nowMs: number): Scheduling {
  const active = isActiveExamWindow(reg, nowMs);
  const delaySec = nextSyncDelaySeconds(reg.dashboardStatus, active, reg.unchangedPolls ?? 0);

  const completedWithResults = reg.dashboardStatus === DASHBOARD_STATUS.COMPLETED && reg.hasResults;
  const requiresStatusFetch = !completedWithResults; // stop frequent polling once completed+results
  const requiresResultsFetch = shouldFetchResults(reg.dashboardStatus) && !reg.hasResults;

  let priority = PRIORITY_BY_STATUS[reg.dashboardStatus] ?? 65;
  if (active && reg.dashboardStatus === DASHBOARD_STATUS.NOT_STARTED) priority = 35;

  // Staleness: overdue relative to expected interval / no successful sync in window.
  let isStale = false;
  let staleReason: string | null = null;
  let staleSeverity: Scheduling['staleSeverity'] = null;
  const expectedMs = delaySec * 1000;
  const lastOk = reg.lastSuccessfulSyncAt?.getTime() ?? 0;
  const sinceOk = lastOk ? nowMs - lastOk : Infinity;

  if (!completedWithResults) {
    if (active && sinceOk > 3 * expectedMs) {
      isStale = true;
      staleReason = 'No successful sync during active exam window';
      staleSeverity = 'HIGH';
    } else if (reg.nextSyncAt && nowMs - reg.nextSyncAt.getTime() > 5 * expectedMs) {
      isStale = true;
      staleReason = 'Sync overdue beyond expected interval';
      staleSeverity = active ? 'HIGH' : 'MEDIUM';
    } else if (sinceOk > 6 * expectedMs && lastOk > 0) {
      isStale = true;
      staleReason = 'Data older than expected freshness window';
      staleSeverity = 'LOW';
    }
  }

  // Completed + results already fetched is TERMINAL: never re-sync. Push
  // nextSyncAt ~100 years out so the scheduler never picks it up again.
  const TERMINAL_MS = 100 * 365 * 24 * 60 * 60 * 1000;
  const nextSyncAt = completedWithResults
    ? new Date(nowMs + TERMINAL_MS)
    : new Date(nowMs + delaySec * 1000);

  return {
    nextSyncAt,
    syncPriority: priority,
    isActiveExamWindow: active,
    requiresStatusFetch,
    requiresResultsFetch,
    isStale,
    staleReason,
    staleSeverity,
  };
}

/**
 * Enqueue status/results jobs for all registrations that are due. Idempotent
 * via queue dedup, so running this on multiple workers is safe. Skips paused /
 * sync-disabled / inactive workspaces.
 */
/**
 * Attach the single active workspace to any registration that imported without
 * one. Registrations route to a workspace by ExamName at import time; if no
 * alias mapping matched (and there's one workspace for everything), they land
 * with workspaceId=null and the scheduler skips them forever. When exactly one
 * active workspace exists, adopt those orphans so sync can proceed. No-op once
 * there are none, and a no-op when 0 or 2+ workspaces exist (ambiguous).
 */
export async function backfillOrphanWorkspaces(): Promise<number> {
  const actives = await prisma.fastTestWorkspace.findMany({
    where: { isActive: true, deletedAt: null }, take: 2, select: { id: true },
  });
  if (actives.length !== 1) return 0;
  const res = await prisma.examRegistration.updateMany({
    where: { workspaceId: null, deletedAt: null },
    data: { workspaceId: actives[0].id },
  });
  return res.count;
}

export async function enqueueDueJobs(now: () => number = () => Date.now(), limit = 2000): Promise<{ enqueued: number; deduped: number }> {
  // Respect the global on/off switch and time window — don't pile up jobs while paused.
  if (!(await syncAllowedNow(now))) return { enqueued: 0, deduped: 0 };
  // Adopt any workspace-less registrations first (single-workspace deployments).
  await backfillOrphanWorkspaces().catch(() => 0);
  const nowDate = new Date(now());
  const [pausedSubs, pausedYears, mode] = await Promise.all([pausedSubjects(), pausedAcademicYears(), getSyncMode()]);

  const baseWhere = {
    deletedAt: null,
    workspaceId: { not: null },
    workspace: { is: { syncEnabled: true, isActive: true, syncPaused: false, deletedAt: null } },
    syncState: { notIn: ['MANUAL_REVIEW'] },
    ...(pausedSubs.length ? { examSubject: { notIn: pausedSubs } } : {}),
    ...(pausedYears.length ? { academicYear: { notIn: pausedYears } } : {}),
  };
  const select = {
    id: true, workspaceId: true, examName: true, schoolId: true, testCodeNormalized: true,
    dashboardStatus: true, startDate: true, endDate: true, lastSuccessfulSyncAt: true, nextSyncAt: true, unchangedPolls: true,
    _count: { select: { results: true } },
  } as const;

  // SWEEP: round-robin over every NON-TERMINAL code (skip COMPLETED-with-results),
  // oldest-checked first — a continuous sequential sweep ignoring nextSyncAt.
  // ADAPTIVE (default): due by nextSyncAt, highest priority first.
  const due = mode === 'SWEEP'
    ? await prisma.examRegistration.findMany({
        where: { ...baseWhere, NOT: { AND: [{ dashboardStatus: DASHBOARD_STATUS.COMPLETED }, { results: { some: {} } }] } },
        orderBy: [{ lastSyncAt: { sort: 'asc', nulls: 'first' } }],
        take: limit,
        select,
      })
    : await prisma.examRegistration.findMany({
        where: { ...baseWhere, OR: [{ nextSyncAt: null }, { nextSyncAt: { lte: nowDate } }] },
        orderBy: [{ syncPriority: 'asc' }, { nextSyncAt: 'asc' }],
        take: limit,
        select,
      });

  let enqueued = 0;
  let deduped = 0;
  for (const reg of due) {
    const sched = computeScheduling({ ...reg, hasResults: reg._count.results > 0 }, now());

    // Terminal (COMPLETED + results fetched): stop polling. Push nextSyncAt far
    // out and don't enqueue any job.
    if (!sched.requiresStatusFetch && !sched.requiresResultsFetch) {
      await retryOnDeadlock(() => prisma.examRegistration.update({
        where: { id: reg.id },
        data: { nextSyncAt: sched.nextSyncAt, isStale: false, staleReason: null, staleSeverity: null, staleSince: null },
      }));
      continue;
    }

    // Full sync when both status + results needed; else the needed one.
    const jobType = sched.requiresResultsFetch && sched.requiresStatusFetch
      ? JOB_TYPE.SYNC_REGISTRATION_FULL
      : sched.requiresResultsFetch
        ? JOB_TYPE.SYNC_REGISTRATION_RESULTS
        : JOB_TYPE.SYNC_REGISTRATION_STATUS;

    const res = await retryOnDeadlock(() => enqueue({
      jobType,
      priority: sched.syncPriority,
      workspaceId: reg.workspaceId,
      registrationId: reg.id,
      testCodeNormalized: reg.testCodeNormalized,
      subject: reg.examName,
      schoolId: reg.schoolId,
    }));
    if (res.deduped) deduped++;
    else enqueued++;

    // Advance nextSyncAt so we don't re-enqueue every tick before the job runs.
    await retryOnDeadlock(() => prisma.examRegistration.update({
      where: { id: reg.id },
      data: {
        nextSyncAt: sched.nextSyncAt, syncPriority: sched.syncPriority,
        isStale: sched.isStale, staleReason: sched.staleReason, staleSeverity: sched.staleSeverity,
        staleSince: sched.isStale ? (undefined) : null,
      },
    }));
  }
  return { enqueued, deduped };
}

/** Recompute stale flags across registrations (periodic). */
export async function refreshStaleFlags(now: () => number = () => Date.now(), limit = 20000): Promise<number> {
  const regs = await prisma.examRegistration.findMany({
    where: { deletedAt: null },
    select: {
      id: true, dashboardStatus: true, startDate: true, endDate: true, lastSuccessfulSyncAt: true, nextSyncAt: true, unchangedPolls: true,
      isStale: true, staleSince: true, _count: { select: { results: true } },
    },
    take: limit,
  });
  let staleCount = 0;
  for (const reg of regs) {
    const sched = computeScheduling({ ...reg, hasResults: reg._count.results > 0 }, now());
    if (sched.isStale) staleCount++;
    const wasStale = reg.isStale;
    await prisma.examRegistration.update({
      where: { id: reg.id },
      data: {
        isStale: sched.isStale,
        staleReason: sched.staleReason,
        staleSeverity: sched.staleSeverity,
        staleSince: sched.isStale ? (wasStale && reg.staleSince ? reg.staleSince : new Date(now())) : null,
      },
    });
  }
  return staleCount;
}

export { JOB_PRIORITY };
