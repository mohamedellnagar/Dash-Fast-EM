import { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma';
import { DASHBOARD_STATUS, SYNC_STATUS } from '../lib/enums';

// ---------------------------------------------------------------------------
// Phase 2 analytics. Every function takes a pre-built ExamRegistration where
// clause (with school scoping already applied by the caller) so KPIs always
// match the filtered table. Aggregation runs in the DB; nothing is computed in
// the browser. Result-based metrics filter through the registration relation
// so the same filter applies to results.
// ---------------------------------------------------------------------------

const EMPTY_STATUS = { NOT_SYNCED: 0, NOT_STARTED: 0, IN_PROGRESS: 0, COMPLETED: 0, UNDER_REVIEW: 0, REVIEW_FAILED: 0, UNKNOWN: 0 };

function round2(n: number | null | undefined): number | null {
  if (n === null || n === undefined) return null;
  return Math.round(n * 100) / 100;
}

// Short-lived single-flight cache for expensive dashboard aggregates. The wall
// auto-refreshes and several viewers may load the same view, so a 15s TTL turns
// repeated heavy scans into one query while keeping the numbers effectively live.
const _cache = new Map<string, { at: number; p: Promise<unknown> }>();
function memo<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.p as Promise<T>;
  const p = fn().catch((e) => { _cache.delete(key); throw e; });
  _cache.set(key, { at: Date.now(), p });
  // Opportunistic eviction so the map can't grow unbounded across many filters.
  if (_cache.size > 200) for (const [k, v] of _cache) if (Date.now() - v.at > ttlMs) _cache.delete(k);
  return p as Promise<T>;
}
const DASH_TTL = 15000;

/** result where-clause that mirrors the registration filter (single source). */
function resultWhere(where: Prisma.ExamRegistrationWhereInput): Prisma.FastTestResultWhereInput {
  return { registration: { is: where } };
}

export async function statusCounts(where: Prisma.ExamRegistrationWhereInput) {
  const grouped = await prisma.examRegistration.groupBy({
    by: ['dashboardStatus'],
    where,
    _count: { _all: true },
  });
  const counts = { ...EMPTY_STATUS } as Record<string, number>;
  let total = 0;
  for (const g of grouped) {
    counts[g.dashboardStatus] = g._count._all;
    total += g._count._all;
  }
  return { counts, total };
}

/** Core KPI block shared by overview/schools/subjects. */
export async function kpiBlock(where: Prisma.ExamRegistrationWhereInput) {
  const rw = resultWhere(where);
  // One combined aggregate over FastTestResult instead of three separate JOINs.
  const [{ counts, total }, syncErrors, staleCount, resultAgg] = await Promise.all([
    statusCounts(where),
    prisma.examRegistration.count({ where: { AND: [where, { syncStatus: { in: [SYNC_STATUS.ERROR, SYNC_STATUS.MANUAL_REVIEW] } }] } }),
    prisma.examRegistration.count({ where: { AND: [where, { isStale: true }] } }),
    prisma.fastTestResult.aggregate({
      where: rw,
      _avg: { secondsUsed: true, completionPercentage: true, rawScore: true, scaledScore: true },
      _sum: { correctCount: true, incorrectCount: true, skippedCount: true },
    }),
  ]);
  const scoreAgg = resultAgg;

  const completionRate = total ? round2((counts.COMPLETED / total) * 100) : 0;
  const correct = resultAgg._sum.correctCount ?? 0;
  const incorrect = resultAgg._sum.incorrectCount ?? 0;
  const skipped = resultAgg._sum.skippedCount ?? 0;

  return {
    totalRegistered: total,
    ...counts,
    completionRate,
    syncErrors,
    staleCount,
    avgTimeUsedSeconds: resultAgg._avg.secondsUsed !== null ? Math.round(resultAgg._avg.secondsUsed!) : null,
    avgCompletionPercentage: round2(resultAgg._avg.completionPercentage),
    avgRawScore: round2(scoreAgg._avg.rawScore),
    avgScaledScore: round2(scoreAgg._avg.scaledScore),
    correct, incorrect, skipped,
  };
}

export async function statusDistribution(where: Prisma.ExamRegistrationWhereInput) {
  const { counts, total } = await statusCounts(where);
  return { counts, total };
}

/** Schools whose students' statuses changed TODAY, with the grades touched per
 * school. Powers the "Today's Activity" panel on the operations wall. */
export async function todaysActivity(where: Prisma.ExamRegistrationWhereInput) {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const rows = await prisma.examRegistration.groupBy({
    by: ['schoolId', 'grade'],
    where: { AND: [where, { statusChangedAt: { gte: start } }] },
    _count: { _all: true },
  });
  if (!rows.length) return { schools: [], totalStudents: 0, totalSchools: 0 };
  const schoolIds = [...new Set(rows.map((r) => r.schoolId).filter(Boolean))] as string[];
  const schools = await prisma.school.findMany({ where: { id: { in: schoolIds } }, select: { id: true, name: true } });
  const nameById = new Map(schools.map((s) => [s.id, s.name]));
  const acc = new Map<string, { schoolName: string; total: number; grades: Map<string, number> }>();
  for (const r of rows) {
    const key = r.schoolId ?? 'UNASSIGNED';
    if (!acc.has(key)) acc.set(key, { schoolName: nameById.get(r.schoolId ?? '') ?? 'Unassigned', total: 0, grades: new Map() });
    const s = acc.get(key)!;
    s.total += r._count._all;
    const g = r.grade ?? '—';
    s.grades.set(g, (s.grades.get(g) ?? 0) + r._count._all);
  }
  const list = [...acc.values()]
    .map((s) => ({ schoolName: s.schoolName, total: s.total, grades: [...s.grades.entries()].map(([grade, count]) => ({ grade, count })).sort((a, b) => b.count - a.count) }))
    .sort((a, b) => b.total - a.total);
  return { schools: list, totalStudents: list.reduce((n, s) => n + s.total, 0), totalSchools: list.length };
}

/** Most recently synced registrations — a live feed for the operations wall. */
export async function recentSyncActivity(where: Prisma.ExamRegistrationWhereInput, limit = 40) {
  const rows = await prisma.examRegistration.findMany({
    where: { AND: [where, { lastSyncAt: { not: null } }] },
    orderBy: { lastSyncAt: 'desc' },
    take: limit,
    select: { testCodeOriginal: true, dashboardStatus: true, examSubject: true, lastSyncAt: true },
  });
  return rows.map((r) => ({ code: r.testCodeOriginal, status: r.dashboardStatus, subject: r.examSubject, at: r.lastSyncAt }));
}

/** KPIs + charts for the executive overview (cached ~15s). */
export function overview(where: Prisma.ExamRegistrationWhereInput) {
  return memo('overview:' + JSON.stringify(where), DASH_TTL, () => overviewUncached(where));
}
async function overviewUncached(where: Prisma.ExamRegistrationWhereInput) {
  const [kpis, apiErrors, apiAgg, lastSync, studentCount] = await Promise.all([
    kpiBlock(where),
    prisma.apiRequestLog.count({ where: { success: false } }),
    prisma.apiRequestLog.aggregate({ _avg: { responseTimeMs: true }, _count: { _all: true } }),
    prisma.fastTestWorkspace.findFirst({ where: { lastSuccessfulSyncAt: { not: null } }, orderBy: { lastSuccessfulSyncAt: 'desc' }, select: { lastSuccessfulSyncAt: true } }),
    countDistinctStudents(where),
  ]);
  const apiTotal = apiAgg._count._all || 0;
  const apiSuccessRate = apiTotal ? round2(((apiTotal - apiErrors) / apiTotal) * 100) : 100;
  return {
    ...kpis,
    studentCount, // unique students (by Emirates ID) — one student may sit many exams
    apiErrors,
    apiSuccessRate,
    avgResponseTimeMs: Math.round(apiAgg._avg.responseTimeMs ?? 0),
    lastSuccessfulSyncAt: lastSync?.lastSuccessfulSyncAt ?? null,
  };
}

/**
 * Count UNIQUE students (distinct Emirates ID) among registrations matching the
 * filter — a student may have multiple exam registrations, so this is not the
 * registration count. Students with no Emirates ID fall back to their source
 * StudentId so they are still counted once.
 */
export async function countDistinctStudents(where: Prisma.ExamRegistrationWhereInput): Promise<number> {
  // Uses the denormalized ExamRegistration.emiratesId (indexed) — no Student JOIN.
  const students = await prisma.examRegistration.findMany({
    where: { AND: [where, { emiratesId: { not: null, notIn: [''] } }] },
    select: { emiratesId: true },
    distinct: ['emiratesId'],
  });
  const withEid = students.length;
  // Fallback bucket: registrations with no Emirates ID, counted by studentExternalId.
  const noEid = await prisma.examRegistration.groupBy({
    by: ['studentExternalId'],
    where: { AND: [where, { OR: [{ emiratesId: null }, { emiratesId: '' }] }] },
  });
  return withEid + noEid.length;
}

// ---- per-school table -----------------------------------------------------

export function schoolsSummary(where: Prisma.ExamRegistrationWhereInput) {
  return memo('schools:' + JSON.stringify(where), DASH_TTL, () => schoolsSummaryUncached(where));
}
async function schoolsSummaryUncached(where: Prisma.ExamRegistrationWhereInput) {
  const grouped = await prisma.examRegistration.groupBy({
    by: ['schoolId', 'dashboardStatus'],
    where,
    _count: { _all: true },
  });
  const schoolIds = [...new Set(grouped.map((g) => g.schoolId).filter(Boolean))] as string[];
  const [schools, resultRows, errRows] = await Promise.all([
    prisma.school.findMany({ where: { id: { in: schoolIds } } }),
    prisma.fastTestResult.groupBy({
      by: ['schoolId'],
      where: { registration: { is: where }, schoolId: { in: schoolIds } },
      _avg: { secondsUsed: true, rawScore: true, scaledScore: true },
    }),
    prisma.examRegistration.groupBy({
      by: ['schoolId'],
      where: { AND: [where, { syncStatus: { in: [SYNC_STATUS.ERROR, SYNC_STATUS.MANUAL_REVIEW] } }] },
      _count: { _all: true },
    }),
  ]);
  const nameById = new Map(schools.map((s) => [s.id, s]));
  const resById = new Map(resultRows.map((r) => [r.schoolId, r]));
  const errById = new Map(errRows.map((r) => [r.schoolId, r._count._all]));

  const acc = new Map<string, any>();
  for (const g of grouped) {
    const key = g.schoolId ?? 'UNASSIGNED';
    if (!acc.has(key)) {
      const s = key !== 'UNASSIGNED' ? nameById.get(key) : undefined;
      acc.set(key, {
        schoolId: key, externalId: s?.externalId ?? null, schoolName: s?.name ?? 'Unassigned',
        total: 0, ...EMPTY_STATUS,
        apiErrors: errById.get(g.schoolId) ?? 0,
        avgTimeUsed: resById.get(g.schoolId)?._avg.secondsUsed ?? null,
        avgRawScore: round2(resById.get(g.schoolId)?._avg.rawScore),
        avgScaledScore: round2(resById.get(g.schoolId)?._avg.scaledScore),
      });
    }
    const row = acc.get(key);
    row[g.dashboardStatus] = (row[g.dashboardStatus] ?? 0) + g._count._all;
    row.total += g._count._all;
  }
  return [...acc.values()]
    .map((r) => ({ ...r, completionRate: r.total ? Math.round((r.COMPLETED / r.total) * 100) : 0, avgTimeUsed: r.avgTimeUsed !== null ? Math.round(r.avgTimeUsed) : null }))
    .sort((a, b) => b.total - a.total);
}

// ---- per-subject table ----------------------------------------------------

export function subjectsSummary(where: Prisma.ExamRegistrationWhereInput) {
  return memo('subjects:' + JSON.stringify(where), DASH_TTL, () => subjectsSummaryUncached(where));
}
async function subjectsSummaryUncached(where: Prisma.ExamRegistrationWhereInput) {
  const grouped = await prisma.examRegistration.groupBy({
    by: ['examSubject', 'dashboardStatus'],
    where,
    _count: { _all: true },
  });
  const resRows = await prisma.fastTestResult.groupBy({
    by: ['examSubject'],
    where: { registration: { is: where } },
    _avg: { secondsUsed: true, rawScore: true, scaledScore: true },
    _sum: { correctCount: true, incorrectCount: true, skippedCount: true },
  });
  const resBySubj = new Map(resRows.map((r) => [r.examSubject, r]));
  const acc = new Map<string, any>();
  for (const g of grouped) {
    const key = g.examSubject;
    if (!acc.has(key)) {
      const r = resBySubj.get(key);
      acc.set(key, {
        examSubject: key, total: 0, ...EMPTY_STATUS,
        avgTimeUsed: r?._avg.secondsUsed != null ? Math.round(r._avg.secondsUsed) : null,
        avgRawScore: round2(r?._avg.rawScore), avgScaledScore: round2(r?._avg.scaledScore),
        correct: r?._sum.correctCount ?? 0, incorrect: r?._sum.incorrectCount ?? 0, skipped: r?._sum.skippedCount ?? 0,
      });
    }
    const row = acc.get(key);
    row[g.dashboardStatus] = (row[g.dashboardStatus] ?? 0) + g._count._all;
    row.total += g._count._all;
  }
  return [...acc.values()]
    .map((r) => ({ ...r, completionRate: r.total ? Math.round((r.COMPLETED / r.total) * 100) : 0 }))
    .sort((a, b) => b.total - a.total);
}

// ---- generic dimension breakdowns ----------------------------------------

export async function completionByGrade(where: Prisma.ExamRegistrationWhereInput) {
  const grouped = await prisma.examRegistration.groupBy({ by: ['grade', 'dashboardStatus'], where, _count: { _all: true } });
  const acc = new Map<string, { grade: string; total: number; completed: number }>();
  for (const g of grouped) {
    const key = g.grade ?? '—';
    acc.set(key, acc.get(key) ?? { grade: key, total: 0, completed: 0 });
    const row = acc.get(key)!;
    row.total += g._count._all;
    if (g.dashboardStatus === DASHBOARD_STATUS.COMPLETED) row.completed += g._count._all;
  }
  return [...acc.values()].map((r) => ({ ...r, completionRate: r.total ? Math.round((r.completed / r.total) * 100) : 0 })).sort((a, b) => a.grade.localeCompare(b.grade));
}

export async function durationsBySubject(where: Prisma.ExamRegistrationWhereInput) {
  const rows = await prisma.fastTestResult.groupBy({ by: ['examSubject'], where: { registration: { is: where } }, _avg: { secondsUsed: true } });
  return rows.map((r) => ({ examSubject: r.examSubject ?? '—', avgSeconds: r._avg.secondsUsed != null ? Math.round(r._avg.secondsUsed) : null })).sort((a, b) => (b.avgSeconds ?? 0) - (a.avgSeconds ?? 0));
}

export async function scoresBySubject(where: Prisma.ExamRegistrationWhereInput) {
  const rows = await prisma.fastTestResult.groupBy({ by: ['examSubject'], where: { registration: { is: where } }, _avg: { rawScore: true, scaledScore: true } });
  return rows.map((r) => ({ examSubject: r.examSubject ?? '—', avgRawScore: round2(r._avg.rawScore), avgScaledScore: round2(r._avg.scaledScore) })).sort((a, b) => (b.avgRawScore ?? 0) - (a.avgRawScore ?? 0));
}

export async function scoresBySchool(where: Prisma.ExamRegistrationWhereInput) {
  const rows = await prisma.fastTestResult.groupBy({ by: ['schoolId'], where: { registration: { is: where } }, _avg: { rawScore: true, secondsUsed: true } });
  const ids = rows.map((r) => r.schoolId).filter(Boolean) as string[];
  const schools = await prisma.school.findMany({ where: { id: { in: ids } } });
  const nameById = new Map(schools.map((s) => [s.id, s.name]));
  return rows.map((r) => ({ schoolId: r.schoolId, schoolName: r.schoolId ? nameById.get(r.schoolId) ?? 'Unknown' : 'Unassigned', avgRawScore: round2(r._avg.rawScore), avgSeconds: r._avg.secondsUsed != null ? Math.round(r._avg.secondsUsed) : null }));
}

export async function correctIncorrectSkipped(where: Prisma.ExamRegistrationWhereInput) {
  const agg = await prisma.fastTestResult.aggregate({ where: { registration: { is: where } }, _sum: { correctCount: true, incorrectCount: true, skippedCount: true } });
  return { correct: agg._sum.correctCount ?? 0, incorrect: agg._sum.incorrectCount ?? 0, skipped: agg._sum.skippedCount ?? 0 };
}

/**
 * Operational exam analytics for the delivery dashboard: exam-time distribution
 * with a rapid-completion (integrity) flag, activity by hour, and daily
 * completion velocity. Scoped by program (SPA/ABA) since the walls are per-program.
 */
export async function examOperationalAnalytics(programType?: string) {
  const prog = programType ? Prisma.sql`AND r.programType = ${programType}` : Prisma.empty;

  const [timeBuckets, rapid, byHour, daily] = await Promise.all([
    prisma.$queryRaw<Array<{ label: string; ord: number; n: bigint }>>`
      SELECT CASE
        WHEN fr.secondsUsed < 120 THEN '<2m'
        WHEN fr.secondsUsed < 300 THEN '2-5m'
        WHEN fr.secondsUsed < 600 THEN '5-10m'
        WHEN fr.secondsUsed < 900 THEN '10-15m'
        WHEN fr.secondsUsed < 1200 THEN '15-20m'
        ELSE '20m+' END AS label,
        CASE
        WHEN fr.secondsUsed < 120 THEN 1 WHEN fr.secondsUsed < 300 THEN 2
        WHEN fr.secondsUsed < 600 THEN 3 WHEN fr.secondsUsed < 900 THEN 4
        WHEN fr.secondsUsed < 1200 THEN 5 ELSE 6 END AS ord,
        COUNT(*) n
      FROM FastTestResult fr JOIN ExamRegistration r ON r.id = fr.registrationId
      WHERE fr.secondsUsed IS NOT NULL AND r.deletedAt IS NULL ${prog}
      GROUP BY label, ord ORDER BY ord`,
    prisma.$queryRaw<Array<{ rapid: bigint; total: bigint; avgs: number }>>`
      SELECT SUM(fr.secondsUsed < 120) rapid, COUNT(*) total, ROUND(AVG(fr.secondsUsed)) avgs
      FROM FastTestResult fr JOIN ExamRegistration r ON r.id = fr.registrationId
      WHERE fr.secondsUsed IS NOT NULL AND r.deletedAt IS NULL ${prog}`,
    prisma.$queryRaw<Array<{ h: number; n: bigint }>>`
      SELECT HOUR(fr.startTime) h, COUNT(*) n
      FROM FastTestResult fr JOIN ExamRegistration r ON r.id = fr.registrationId
      WHERE fr.startTime IS NOT NULL AND r.deletedAt IS NULL ${prog}
      GROUP BY h ORDER BY h`,
    prisma.$queryRaw<Array<{ d: string; n: bigint }>>`
      SELECT DATE_FORMAT(fr.startTime, '%Y-%m-%d') d, COUNT(*) n
      FROM FastTestResult fr JOIN ExamRegistration r ON r.id = fr.registrationId
      WHERE fr.startTime IS NOT NULL AND r.deletedAt IS NULL ${prog}
      GROUP BY d ORDER BY d DESC LIMIT 45`,
  ]);

  const r0 = rapid[0] ?? { rapid: 0n, total: 0n, avgs: 0 };
  return {
    time: {
      avgSeconds: Number(r0.avgs) || 0,
      rapidCount: Number(r0.rapid) || 0,
      total: Number(r0.total) || 0,
      distribution: timeBuckets.map((b) => ({ label: b.label, count: Number(b.n) })),
    },
    byHour: byHour.map((h) => ({ hour: Number(h.h), count: Number(h.n) })),
    daily: daily.map((d) => ({ date: String(d.d), count: Number(d.n) })).reverse(),
  };
}

/** Score distribution buckets (0-20,...,80-100+) from denormalized rawScore. */
export async function scoreDistribution(where: Prisma.ExamRegistrationWhereInput, bucketSize = 20, max = 100) {
  const rows = await prisma.fastTestResult.findMany({ where: { registration: { is: where }, rawScore: { not: null } }, select: { rawScore: true }, take: 20000 });
  const buckets: { label: string; count: number }[] = [];
  const n = Math.ceil(max / bucketSize);
  for (let i = 0; i < n; i++) buckets.push({ label: `${i * bucketSize}-${(i + 1) * bucketSize}`, count: 0 });
  buckets.push({ label: `${max}+`, count: 0 });
  for (const r of rows) {
    const v = r.rawScore ?? 0;
    const idx = v >= max ? buckets.length - 1 : Math.min(Math.floor(v / bucketSize), buckets.length - 2);
    buckets[idx].count++;
  }
  return buckets;
}

/** Registration trend grouped by exam start date (portable string groupBy). */
export async function completionTrends(where: Prisma.ExamRegistrationWhereInput) {
  const rows = await prisma.examRegistration.groupBy({
    by: ['startDate', 'dashboardStatus'],
    where: { AND: [where, { startDate: { not: null } }] },
    _count: { _all: true },
  });
  const acc = new Map<string, { date: string; total: number; completed: number }>();
  for (const g of rows) {
    const key = g.startDate as string;
    acc.set(key, acc.get(key) ?? { date: key, total: 0, completed: 0 });
    const row = acc.get(key)!;
    row.total += g._count._all;
    if (g.dashboardStatus === DASHBOARD_STATUS.COMPLETED) row.completed += g._count._all;
  }
  return [...acc.values()].sort((a, b) => a.date.localeCompare(b.date));
}

// ---- API / workspace health ----------------------------------------------

const STALE_MS = 15 * 60 * 1000;

export async function apiHealth() {
  const [workspaces, recent, errDist] = await Promise.all([
    prisma.fastTestWorkspace.findMany({ where: { deletedAt: null }, orderBy: { subjectCode: 'asc' } }),
    prisma.apiRequestLog.findMany({ orderBy: { requestedAt: 'desc' }, take: 50, select: { requestedAt: true, responseTimeMs: true, success: true, workspaceId: true } }),
    prisma.apiRequestLog.groupBy({ by: ['fastTestErrorCode'], where: { success: false }, _count: { _all: true } }),
  ]);

  const now = Date.now();
  const perWorkspace = await Promise.all(
    workspaces.map(async (w) => {
      const [agg, fails, staleCount] = await Promise.all([
        prisma.apiRequestLog.aggregate({ where: { workspaceId: w.id }, _avg: { responseTimeMs: true }, _count: { _all: true } }),
        prisma.apiRequestLog.count({ where: { workspaceId: w.id, success: false } }),
        prisma.examRegistration.count({ where: { workspaceId: w.id, deletedAt: null, OR: [{ lastSyncAt: null }, { lastSyncAt: { lt: new Date(now - STALE_MS) } }] } }),
      ]);
      const total = agg._count._all || 0;
      return {
        workspaceId: w.id,
        workspaceName: w.workspaceName,
        subjectCode: w.subjectCode,
        isActive: w.isActive,
        syncEnabled: w.syncEnabled,
        connectionStatus: w.lastAuthenticationStatus ?? 'UNKNOWN',
        lastAuthenticationAt: w.lastAuthenticationAt,
        lastAuthenticationStatus: w.lastAuthenticationStatus,
        lastAuthenticationError: w.lastAuthenticationError,
        lastSuccessfulSyncAt: w.lastSuccessfulSyncAt,
        avgResponseTimeMs: Math.round(agg._avg.responseTimeMs ?? 0),
        apiSuccessRate: total ? round2(((total - fails) / total) * 100) : 100,
        staleDataCount: staleCount,
        // never expose secrets
      };
    }),
  );

  return {
    workspaces: perWorkspace,
    responseTimeTrend: recent.reverse().map((r) => ({ at: r.requestedAt, ms: r.responseTimeMs ?? 0, success: r.success })),
    errorDistribution: errDist.map((e) => ({ code: e.fastTestErrorCode ?? 'UNKNOWN', count: e._count._all })),
  };
}

/** Paginated registration listing for a pre-built (scoped) where clause. */
export async function listRegistrationsWhere(
  where: Prisma.ExamRegistrationWhereInput,
  page = 1,
  pageSize = 25,
  sortBy = 'updatedAt',
  sortDir: 'asc' | 'desc' = 'desc',
) {
  const orderBy = { [sortBy]: sortDir } as any;
  const [total, rows] = await Promise.all([
    prisma.examRegistration.count({ where }),
    prisma.examRegistration.findMany({
      where, orderBy, skip: (page - 1) * pageSize, take: pageSize,
      include: { student: true, school: true, subject: true, results: { orderBy: { createdAt: 'desc' }, take: 1 } },
    }),
  ]);
  return { rows, page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
}

/** One workspace's health by subject code. */
export async function workspaceHealthForSubject(examSubject: string) {
  const health = await apiHealth();
  const norm = examSubject.trim().toUpperCase();
  return health.workspaces.find((w) => w.subjectCode === norm || w.subjectCode === norm.replace(/\s+/g, '_')) ?? null;
}
