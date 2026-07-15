import { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma';
import { DASHBOARD_STATUS, SYNC_STATUS } from '../lib/enums';

export interface RegistrationFilter {
  schoolIds?: string[]; // restrict (school-scoped users)
  subjectId?: string;
  schoolId?: string;
  grade?: string;
  dashboardStatus?: string;
  search?: string;
}

/** Build a Prisma where-clause from dashboard filters + school scoping. */
export function buildWhere(filter: RegistrationFilter): Prisma.ExamRegistrationWhereInput {
  const where: Prisma.ExamRegistrationWhereInput = { deletedAt: null };
  if (filter.schoolIds && filter.schoolIds.length) where.schoolId = { in: filter.schoolIds };
  if (filter.schoolId) where.schoolId = filter.schoolId;
  if (filter.subjectId) where.subjectId = filter.subjectId;
  if (filter.grade) where.grade = filter.grade;
  if (filter.dashboardStatus) where.dashboardStatus = filter.dashboardStatus;
  if (filter.search) {
    where.OR = [
      { studentExternalId: { contains: filter.search } },
      { testCodeOriginal: { contains: filter.search } },
      { testCodeNormalized: { contains: filter.search } },
      { examName: { contains: filter.search } },
    ];
  }
  return where;
}

export async function statusCounts(filter: RegistrationFilter) {
  const where = buildWhere(filter);
  const grouped = await prisma.examRegistration.groupBy({
    by: ['dashboardStatus'],
    where,
    _count: { _all: true },
  });
  const counts: Record<string, number> = {
    NOT_SYNCED: 0, NOT_STARTED: 0, IN_PROGRESS: 0, COMPLETED: 0, UNDER_REVIEW: 0, REVIEW_FAILED: 0, UNKNOWN: 0,
  };
  let total = 0;
  for (const g of grouped) {
    counts[g.dashboardStatus] = g._count._all;
    total += g._count._all;
  }
  return { counts, total };
}

export async function executiveKpis(filter: RegistrationFilter) {
  const { counts, total } = await statusCounts(filter);
  const where = buildWhere(filter);

  const [apiErrors, syncErrors, apiStats, resultAgg] = await Promise.all([
    prisma.apiRequestLog.count({ where: { success: false } }),
    prisma.examRegistration.count({ where: { ...where, syncStatus: { in: [SYNC_STATUS.ERROR, SYNC_STATUS.MANUAL_REVIEW] } } }),
    prisma.apiRequestLog.aggregate({ _avg: { responseTimeMs: true }, _count: { _all: true } }),
    prisma.fastTestResult.aggregate({
      _avg: { secondsUsed: true, completionPercentage: true },
    }),
  ]);

  const apiTotal = apiStats._count._all || 0;
  const apiSuccess = apiTotal - (await prisma.apiRequestLog.count({ where: { success: false } }));
  const syncSuccessRate = apiTotal ? Math.round((apiSuccess / apiTotal) * 10000) / 100 : 100;

  const completionRate = total ? Math.round((counts.COMPLETED / total) * 10000) / 100 : 0;

  const scoreAgg = await prisma.fastTestScore.aggregate({ _avg: { rawScore: true, scaledScore: true } });

  return {
    totalRegistered: total,
    ...counts,
    apiErrors,
    syncErrors,
    syncSuccessRate,
    avgResponseTimeMs: Math.round(apiStats._avg.responseTimeMs ?? 0),
    avgTimeUsedSeconds: Math.round(resultAgg._avg.secondsUsed ?? 0),
    avgRawScore: round2(scoreAgg._avg.rawScore),
    avgScaledScore: round2(scoreAgg._avg.scaledScore),
    avgCompletionPercentage: round2(resultAgg._avg.completionPercentage),
    completionRate,
  };
}

export async function registrationsBySubject(filter: RegistrationFilter) {
  const rows = await prisma.examRegistration.groupBy({
    by: ['examSubject', 'dashboardStatus'],
    where: buildWhere(filter),
    _count: { _all: true },
  });
  const bySubject: Record<string, Record<string, number>> = {};
  for (const r of rows) {
    bySubject[r.examSubject] ??= {};
    bySubject[r.examSubject][r.dashboardStatus] = r._count._all;
  }
  return bySubject;
}

export async function completionBySchool(filter: RegistrationFilter) {
  const rows = await prisma.examRegistration.groupBy({
    by: ['schoolId', 'dashboardStatus'],
    where: buildWhere(filter),
    _count: { _all: true },
  });
  const schoolIds = [...new Set(rows.map((r) => r.schoolId).filter(Boolean))] as string[];
  const schools = await prisma.school.findMany({ where: { id: { in: schoolIds } } });
  const nameById = new Map(schools.map((s) => [s.id, s.name]));
  const acc: Record<string, { name: string; total: number; completed: number }> = {};
  for (const r of rows) {
    const key = r.schoolId ?? 'UNASSIGNED';
    acc[key] ??= { name: nameById.get(key ?? '') ?? 'Unassigned', total: 0, completed: 0 };
    acc[key].total += r._count._all;
    if (r.dashboardStatus === DASHBOARD_STATUS.COMPLETED) acc[key].completed += r._count._all;
  }
  return Object.values(acc).map((s) => ({ ...s, completionRate: s.total ? Math.round((s.completed / s.total) * 100) : 0 }));
}

export interface Paginated<T> {
  rows: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export async function listRegistrations(
  filter: RegistrationFilter,
  page = 1,
  pageSize = 25,
  sortBy = 'updatedAt',
  sortDir: 'asc' | 'desc' = 'desc',
): Promise<Paginated<any>> {
  const where = buildWhere(filter);
  const allowedSort = ['updatedAt', 'lastSyncAt', 'dashboardStatus', 'studentExternalId', 'examSubject', 'grade'];
  const orderBy = { [allowedSort.includes(sortBy) ? sortBy : 'updatedAt']: sortDir } as any;
  const [total, rows] = await Promise.all([
    prisma.examRegistration.count({ where }),
    prisma.examRegistration.findMany({
      where,
      orderBy,
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: { student: true, school: true, subject: true },
    }),
  ]);
  return { rows, page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
}

function round2(n: number | null | undefined): number | null {
  if (n === null || n === undefined) return null;
  return Math.round(n * 100) / 100;
}
