import { prisma } from '../../db/prisma';
import { DASHBOARD_STATUS, SYNC_STATUS, toDashboardStatus } from '../../lib/enums';
import { logger } from '../../lib/logger';
import { env } from '../../config/env';
import { resolveExamTime } from '../../lib/exam-time';
import { FastTestApiError, FastTestClient, fastTestClient } from '../fasttest/client';
import { parseResults } from '../fasttest/results-mapper';
import { getWorkspaceById, resolveWorkspaceBySubject, ResolvedWorkspace } from '../workspace.service';
import { applyJitter, isPermanentError, nextSyncDelaySeconds, retryDelaySeconds, shouldFetchResults } from './policy';

export interface SyncResult {
  ok: boolean;
  registrationId: string;
  dashboardStatus?: string;
  errorType?: string;
  manualReview?: boolean;
}

/** Best-effort check whether the exam window is currently open. */
function inActiveWindow(reg: { startDate?: string | null; endDate?: string | null }, nowMs: number): boolean {
  const start = reg.startDate ? Date.parse(reg.startDate) : NaN;
  const end = reg.endDate ? Date.parse(reg.endDate) : NaN;
  if (Number.isNaN(start) || Number.isNaN(end)) return false;
  return nowMs >= start && nowMs <= end;
}

/**
 * Synchronize a single registration's FastTest status (and results when the
 * status warrants). Idempotent: safe to run repeatedly. Persists a status
 * snapshot with the full raw payload and updates denormalized fields for fast
 * dashboard reads. Never overwrites attendanceOriginal.
 */
export async function syncRegistration(
  registrationId: string,
  client: FastTestClient = fastTestClient,
  now: () => number = () => Date.now(),
): Promise<SyncResult> {
  const reg = await prisma.examRegistration.findFirst({ where: { id: registrationId, deletedAt: null } });
  if (!reg) return { ok: false, registrationId, errorType: 'NOT_FOUND' };

  // Resolve workspace: prefer bound workspaceId, else resolve by ExamName.
  // (ExamName drives API routing; ExamSubject is analytics-only.)
  let ws: ResolvedWorkspace | null = null;
  if (reg.workspaceId) ws = await getWorkspaceById(reg.workspaceId);
  if (!ws && reg.examName) ws = await resolveWorkspaceBySubject(reg.examName);

  if (!ws) {
    await markError(registrationId, 'WORKSPACE_MISMATCH', 'No active workspace resolves this exam name', true, now);
    return { ok: false, registrationId, errorType: 'WORKSPACE_MISMATCH', manualReview: true };
  }

  // Bind workspace if it was resolved by subject.
  if (!reg.workspaceId) {
    await prisma.examRegistration.update({ where: { id: registrationId }, data: { workspaceId: ws.workspaceId } }).catch(() => {});
  }

  try {
    const { dashboardStatus, unchangedPolls } = await fetchAndPersistStatus(reg, ws, client, now);
    // Adaptive backoff (unchangedPolls) + jitter to de-synchronize the herd.
    const delay = applyJitter(nextSyncDelaySeconds(dashboardStatus, inActiveWindow(reg, now()), unchangedPolls));
    await prisma.examRegistration.update({ where: { id: registrationId }, data: { nextSyncAt: new Date(now() + delay * 1000) } });

    // Fetch results once for terminal-ish statuses.
    if (shouldFetchResults(dashboardStatus)) {
      await syncResults(reg, ws, client).catch((e) => {
        logger.warn({ registrationId, err: (e as Error).message }, 'results fetch failed (status sync still OK)');
      });
    }

    return { ok: true, registrationId, dashboardStatus };
  } catch (err) {
    const ft = err as FastTestApiError;
    const errorType = ft.errorType ?? 'INVALID_RESPONSE';
    const permanent = isPermanentError(errorType as any);
    const nextRetry = (reg.syncRetryCount ?? 0) + 1;
    const giveUp = permanent || nextRetry > 3;
    await markError(registrationId, errorType, ft.message ?? 'sync error', giveUp, now, nextRetry);
    return { ok: false, registrationId, errorType, manualReview: giveUp };
  }
}

interface RegDims {
  id: string;
  testCodeNormalized: string;
  schoolId: string | null;
  subjectId: string | null;
  grade: string | null;
  examSubject: string;
  // Scheduled daily window (source strings). Recovers the AM/PM marker FastTest
  // drops — see src/lib/exam-time.ts.
  startTime?: string | null;
  endTime?: string | null;
}

interface RegStatusRow {
  id: string;
  testCodeNormalized: string;
  dashboardStatus: string; // previous status — compared to detect a change
  unchangedPolls: number; // running count of consecutive unchanged polls
  fastTestTestId: string | null;
  fastTestTestName: string | null;
  fastTestExamineeId: string | null;
  fastTestRegistrationDate: string | null;
}

/**
 * Single-attempt status fetch + persistence. Throws FastTestApiError on API
 * failure (the durable queue owns retry/backoff). Persists the snapshot with
 * the full raw payload, updates denormalized fields, and marks the workspace +
 * registration lastSuccessfulSyncAt. Never overwrites attendanceOriginal.
 */
export async function fetchAndPersistStatus(
  reg: RegStatusRow,
  ws: ResolvedWorkspace,
  client: FastTestClient = fastTestClient,
  now: () => number = () => Date.now(),
): Promise<{ dashboardStatus: string; rawStatus: string; unchangedPolls: number }> {
  const registrationId = reg.id;
  const status = await client.getStatus(ws, reg.testCodeNormalized);
  const rawStatus = (status.status ?? '').toString();
  const dashboardStatus = toDashboardStatus(rawStatus);
  // Adaptive-backoff counter: same status as last time → grow; changed → reset.
  const statusChanged = dashboardStatus !== reg.dashboardStatus;
  const unchangedPolls = statusChanged ? 0 : (reg.unchangedPolls ?? 0) + 1;

  await prisma.fastTestStatusSnapshot.create({
    data: {
      registrationId, workspaceId: ws.workspaceId,
      status: rawStatus || 'UNKNOWN', dashboardStatus,
      testId: status.testId != null ? String(status.testId) : null,
      testName: status.testName ?? null,
      firstName: status.firstName ?? null,
      lastName: status.lastName ?? null,
      externalId: status.externalId != null ? String(status.externalId) : null,
      examineeId: status.examineeId != null ? String(status.examineeId) : null,
      registrationDate: status.registrationDate ?? null,
      rawJson: JSON.stringify(status),
    },
  });

  await prisma.examRegistration.update({
    where: { id: registrationId },
    data: {
      fastTestStatus: rawStatus || null,
      dashboardStatus,
      fastTestTestId: status.testId != null ? String(status.testId) : reg.fastTestTestId,
      fastTestTestName: status.testName ?? reg.fastTestTestName,
      fastTestExamineeId: status.examineeId != null ? String(status.examineeId) : reg.fastTestExamineeId,
      fastTestRegistrationDate: status.registrationDate ?? reg.fastTestRegistrationDate,
      lastSyncAt: new Date(now()),
      lastSuccessfulSyncAt: new Date(now()),
      syncStatus: SYNC_STATUS.OK,
      syncError: null,
      syncRetryCount: 0,
      unchangedPolls,
      ...(statusChanged ? { statusChangedAt: new Date(now()) } : {}),
    },
  });
  await prisma.fastTestWorkspace.update({ where: { id: ws.workspaceId }, data: { lastSuccessfulSyncAt: new Date(now()) } }).catch(() => {});
  return { dashboardStatus, rawStatus, unchangedPolls };
}

/** Public single-attempt results fetch (throws on API failure). */
export async function fetchAndPersistResults(reg: RegDims, ws: ResolvedWorkspace, client: FastTestClient = fastTestClient): Promise<void> {
  return syncResults(reg, ws, client);
}

async function syncResults(reg: RegDims, ws: ResolvedWorkspace, client: FastTestClient): Promise<void> {
  const registrationId = reg.id;
  const payload = await client.getResults(ws, reg.testCodeNormalized);
  const parsed = parseResults(payload);
  // Primary score = first score row (results-mapper aggregates item counts).
  const primary = parsed.scores[0];

  // FastTest records exam times on a US clock and sends them with no timezone,
  // so convert to a real instant here — every consumer then reads UTC instead
  // of re-interpreting a naive string. The raw string is stored alongside.
  const examTime = resolveExamTime({
    raw: parsed.startTime,
    // Per workspace: FastTest's timezone setting differs between them.
    sourceTimeZone: ws.sourceTimeZone ?? env.fasttest.sourceTimezone,
    displayTimeZone: env.displayTimezone,
    windowStart: reg.startTime,
    windowEnd: reg.endTime,
  });

  await prisma.$transaction(async (tx) => {
    // Replace prior result rows for idempotency.
    const existing = await tx.fastTestResult.findMany({ where: { registrationId }, select: { id: true } });
    if (existing.length) {
      await tx.fastTestScore.deleteMany({ where: { resultId: { in: existing.map((e) => e.id) } } });
      await tx.fastTestResult.deleteMany({ where: { registrationId } });
    }
    const result = await tx.fastTestResult.create({
      data: {
        registrationId,
        workspaceId: ws.workspaceId,
        firstName: parsed.firstName ?? null,
        lastName: parsed.lastName ?? null,
        externalId: parsed.externalId ?? null,
        examineeId: parsed.examineeId ?? null,
        email: parsed.email ?? null,
        registrationDate: parsed.registrationDate ?? null,
        testName: parsed.testName ?? null,
        startTime: parsed.startTime ?? null,
        startTimeUtc: examTime.utc,
        startTimeResolution: examTime.resolution,
        startTimeSourceTz: examTime.sourceTimeZone,
        secondsUsed: parsed.secondsUsed ?? null,
        passed: parsed.passed ?? null,
        testSessionId: parsed.testSessionId ?? null,
        testSessionName: parsed.testSessionName ?? null,
        examineeGroupId: parsed.examineeGroupId ?? null,
        examineeGroupPath: parsed.examineeGroupPath ?? null,
        constructorUrl: parsed.constructorUrl ?? null,
        attemptedItems: parsed.attemptedItems ?? null,
        totalItemsCount: parsed.totalItemsCount ?? null,
        completionPercentage: parsed.completionPercentage ?? null,
        durationFormatted: parsed.durationFormatted ?? null,
        startDate: parsed.startDate ?? null,
        startTimeOnly: parsed.startTimeOnly ?? null,
        // Denormalized primary-score + dimensions for analytics aggregation.
        rawScore: primary?.rawScore ?? null,
        scaledScore: primary?.scaledScore ?? null,
        sumScore: primary?.sumScore ?? null,
        cutScore: primary?.cutScore ?? null,
        correctCount: primary?.correct ?? null,
        incorrectCount: primary?.incorrect ?? null,
        skippedCount: primary?.skipped ?? null,
        schoolId: reg.schoolId,
        subjectId: reg.subjectId,
        grade: reg.grade,
        examSubject: reg.examSubject,
        rawJson: parsed.rawJson,
        syncStatus: 'OK',
      },
    });
    for (const s of parsed.scores) {
      await tx.fastTestScore.create({ data: { resultId: result.id, ...s } });
    }
    // Denormalize secondsUsed / start time onto the registration.
    await tx.examRegistration.update({
      where: { id: registrationId },
      data: {
        secondsUsed: parsed.secondsUsed ?? undefined,
        actualStartTime: parsed.startTime ?? undefined,
        actualStartTimeUtc: examTime.utc,
        actualStartTimeResolution: examTime.resolution,
        actualStartLocalHour: examTime.displayHour,
        lastSuccessfulSyncAt: new Date(),
      },
    });
  });
}

async function markError(
  registrationId: string,
  errorType: string,
  message: string,
  manualReview: boolean,
  now: () => number,
  retryCount?: number,
): Promise<void> {
  const delay = manualReview ? null : retryDelaySeconds(retryCount ?? 1);
  await prisma.examRegistration.update({
    where: { id: registrationId },
    data: {
      syncStatus: manualReview ? SYNC_STATUS.MANUAL_REVIEW : SYNC_STATUS.ERROR,
      syncError: `${errorType}: ${message}`.slice(0, 500),
      syncRetryCount: retryCount ?? undefined,
      nextSyncAt: delay === null ? null : new Date(now() + delay * 1000),
    },
  });
}
