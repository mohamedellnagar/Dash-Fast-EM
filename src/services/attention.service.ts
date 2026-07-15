import { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma';
import { ATTENTION_ISSUE, ATTENTION_META, ATTENTION_STATUS, DASHBOARD_STATUS, SYNC_STATUS, AttentionIssue } from '../lib/enums';

const STALE_MS = 15 * 60 * 1000;

interface DetectedIssue {
  issue: AttentionIssue;
  lastError?: string | null;
  detail?: string;
  retryCount: number;
}

type RegForDetection = {
  id: string;
  schoolId: string | null;
  subjectId: string | null;
  studentId: string | null;
  workspaceId: string | null;
  dashboardStatus: string;
  syncStatus: string;
  syncError: string | null;
  syncRetryCount: number;
  lastSyncAt: Date | null;
  attendanceOriginal: string | null;
  testCodeNormalized: string;
  _count: { results: number };
};

/** Classify a registration into zero or more attention issues. */
export function classify(reg: RegForDetection, now: number): DetectedIssue[] {
  const issues: DetectedIssue[] = [];
  const err = reg.syncError ?? '';
  const add = (issue: AttentionIssue, detail?: string) =>
    issues.push({ issue, lastError: reg.syncError, detail, retryCount: reg.syncRetryCount });

  if (err.startsWith('NOT_FOUND')) add(ATTENTION_ISSUE.API_NOT_FOUND);
  if (err.startsWith('INVALID_TESTCODE') || reg.testCodeNormalized.length < 3) add(ATTENTION_ISSUE.INVALID_TESTCODE);
  if (!reg.workspaceId || err.startsWith('WORKSPACE_MISMATCH')) add(ATTENTION_ISSUE.WORKSPACE_MAPPING_MISSING);
  if (err.startsWith('UNAUTHORIZED') || err.startsWith('AUTH_FAILED') || err.startsWith('TOKEN_EXPIRED')) add(ATTENTION_ISSUE.AUTH_FAILED);
  if (reg.syncStatus === SYNC_STATUS.ERROR && reg.syncRetryCount >= 2) add(ATTENTION_ISSUE.REPEATED_API_ERROR);
  if (reg.syncStatus === SYNC_STATUS.MANUAL_REVIEW) add(ATTENTION_ISSUE.SYNC_FAILED_MAX_RETRIES);

  const active = reg.dashboardStatus === DASHBOARD_STATUS.IN_PROGRESS || reg.dashboardStatus === DASHBOARD_STATUS.NOT_STARTED;
  if (active && reg.lastSyncAt && now - reg.lastSyncAt.getTime() > STALE_MS) add(ATTENTION_ISSUE.STALE_STATUS);

  if (reg.dashboardStatus === DASHBOARD_STATUS.COMPLETED && reg._count.results === 0) add(ATTENTION_ISSUE.NO_RESULTS_AFTER_COMPLETION);

  const absent = (reg.attendanceOriginal ?? '').trim().toLowerCase().startsWith('absent');
  if (absent && (reg.dashboardStatus === DASHBOARD_STATUS.IN_PROGRESS || reg.dashboardStatus === DASHBOARD_STATUS.COMPLETED)) {
    add(ATTENTION_ISSUE.STATUS_CONFLICT, `Attendance=${reg.attendanceOriginal} but status=${reg.dashboardStatus}`);
  }
  if (!reg.studentId) add(ATTENTION_ISSUE.MISSING_STUDENT_MAPPING);

  return issues;
}

/**
 * Recompute the attention queue from current DB state. Idempotent: upserts an
 * item per (registration, issue); OPEN items no longer applicable are marked
 * RESOLVED by SYSTEM (history + notes preserved). Returns counts.
 */
export async function refreshAttention(): Promise<{ detected: number; autoResolved: number }> {
  const now = Date.now();
  const regs = (await prisma.examRegistration.findMany({
    where: { deletedAt: null },
    select: {
      id: true, schoolId: true, subjectId: true, studentId: true, workspaceId: true,
      dashboardStatus: true, syncStatus: true, syncError: true, syncRetryCount: true,
      lastSyncAt: true, attendanceOriginal: true, testCodeNormalized: true,
      _count: { select: { results: true } },
    },
    take: 50000,
  })) as RegForDetection[];

  const detectedKeys = new Set<string>();
  let detected = 0;

  for (const reg of regs) {
    for (const d of classify(reg, now)) {
      detectedKeys.add(`${reg.id}::${d.issue}`);
      detected++;
      const meta = ATTENTION_META[d.issue];
      await prisma.attentionItem.upsert({
        where: { registrationId_issueType: { registrationId: reg.id, issueType: d.issue } },
        create: {
          registrationId: reg.id, schoolId: reg.schoolId, subjectId: reg.subjectId,
          issueType: d.issue, severity: meta.severity, status: ATTENTION_STATUS.OPEN,
          lastError: d.lastError ?? null, retryCount: d.retryCount, detail: d.detail ?? null,
        },
        update: {
          severity: meta.severity, lastError: d.lastError ?? null, retryCount: d.retryCount,
          detail: d.detail ?? null, lastDetectedAt: new Date(),
          // reopen a SYSTEM-resolved item if the issue recurs
          status: undefined,
        },
      });
    }
  }

  // Auto-resolve OPEN/ACKNOWLEDGED items that are no longer detected.
  const openItems = await prisma.attentionItem.findMany({
    where: { status: { in: [ATTENTION_STATUS.OPEN, ATTENTION_STATUS.ACKNOWLEDGED] } },
    select: { id: true, registrationId: true, issueType: true },
  });
  const staleIds = openItems.filter((i) => !detectedKeys.has(`${i.registrationId}::${i.issueType}`)).map((i) => i.id);
  if (staleIds.length) {
    await prisma.attentionItem.updateMany({
      where: { id: { in: staleIds } },
      data: { status: ATTENTION_STATUS.RESOLVED, resolvedAt: new Date(), resolvedBy: 'SYSTEM' },
    });
  }
  return { detected, autoResolved: staleIds.length };
}

export interface AttentionFilter {
  status?: string;
  severity?: string;
  issueType?: string;
  schoolId?: string;
  assignedToUserId?: string;
}

export async function listAttention(
  f: AttentionFilter,
  scopeSchoolIds: string[] | undefined,
  page = 1,
  pageSize = 25,
) {
  const where: Prisma.AttentionItemWhereInput = {};
  if (scopeSchoolIds) where.schoolId = { in: scopeSchoolIds.length ? scopeSchoolIds : ['__none__'] };
  if (f.status) where.status = f.status;
  if (f.severity) where.severity = f.severity;
  if (f.issueType) where.issueType = f.issueType;
  if (f.schoolId) where.schoolId = f.schoolId;
  if (f.assignedToUserId) where.assignedToUserId = f.assignedToUserId;

  const [total, rows] = await Promise.all([
    prisma.attentionItem.count({ where }),
    prisma.attentionItem.findMany({
      where,
      orderBy: [{ severity: 'asc' }, { lastDetectedAt: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        registration: { include: { student: true, school: true, subject: true } },
        assignedTo: { select: { id: true, fullName: true, email: true } },
      },
    }),
  ]);
  const enriched = rows.map((r) => ({ ...r, recommendedAction: ATTENTION_META[r.issueType as AttentionIssue]?.action ?? '' }));
  return { rows: enriched, page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
}

export async function assignItem(id: string, userId: string | null) {
  return prisma.attentionItem.update({ where: { id }, data: { assignedToUserId: userId } });
}

export async function setStatus(id: string, status: string, actorEmail?: string) {
  const data: Prisma.AttentionItemUpdateInput = { status };
  if (status === ATTENTION_STATUS.RESOLVED) {
    data.resolvedAt = new Date();
    data.resolvedBy = actorEmail ?? null;
  }
  return prisma.attentionItem.update({ where: { id }, data });
}

export async function addNote(itemId: string, note: string, userId?: string, email?: string) {
  return prisma.attentionNote.create({
    data: { attentionItemId: itemId, note: note.slice(0, 2000), authorUserId: userId ?? null, authorEmail: email ?? null },
  });
}

export async function attentionSummary(scopeSchoolIds: string[] | undefined) {
  const where: Prisma.AttentionItemWhereInput = { status: { in: [ATTENTION_STATUS.OPEN, ATTENTION_STATUS.ACKNOWLEDGED] } };
  if (scopeSchoolIds) where.schoolId = { in: scopeSchoolIds.length ? scopeSchoolIds : ['__none__'] };
  const bySeverity = await prisma.attentionItem.groupBy({ by: ['severity'], where, _count: { _all: true } });
  const byIssue = await prisma.attentionItem.groupBy({ by: ['issueType'], where, _count: { _all: true } });
  const total = bySeverity.reduce((s, r) => s + r._count._all, 0);
  return {
    total,
    bySeverity: Object.fromEntries(bySeverity.map((r) => [r.severity, r._count._all])),
    byIssue: byIssue.map((r) => ({ issueType: r.issueType, count: r._count._all })),
  };
}
