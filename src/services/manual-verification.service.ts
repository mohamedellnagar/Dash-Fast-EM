import { v4 as uuid } from 'uuid';
import { prisma } from '../db/prisma';
import { logger } from '../lib/logger';
import { normalizeTestCode } from '../lib/testcode';
import { toDashboardStatus, SYNC_ERROR } from '../lib/enums';
import { maskSecret } from '../lib/crypto';
import { resolveWorkspaceBySubject, getWorkspaceById, ResolvedWorkspace } from './workspace.service';
import { FastTestClient, FastTestApiError, fastTestClient, ProbeResult } from './fasttest/client';
import { parseResults, formatDuration } from './fasttest/results-mapper';
import { resolveExamTime, formatInZone, RESOLVED_STATES } from '../lib/exam-time';
import { env } from '../config/env';

/**
 * Manual Verification — read-only lookup of a single TestCode.
 *
 * Strictly a diagnostic probe: it authenticates with the workspace's existing
 * credentials, GETs the two lookup endpoints, reads the local row, and reports
 * what it found. It creates no scheduling, no registration and no TestCode, and
 * writes nothing except its own audit row in ManualVerificationLog.
 *
 * The two FastTest calls are independent on purpose. A 404 on /results (results
 * not published yet) is an ordinary outcome for a student who has not finished,
 * and it must never suppress a successful /status lookup — so each call is
 * probed for its outcome rather than thrown, and both are reported side by side.
 */

export type ComparisonVerdict = 'MATCH' | 'WARNING' | 'MISMATCH' | 'NOT_ENOUGH_DATA';

export interface Comparison {
  key: string;
  label: string;
  verdict: ComparisonVerdict;
  local: string | null;
  fastTest: string | null;
  note?: string;
}

export interface EndpointOutcome {
  success: boolean;
  httpCode: number | null;
  latencyMs: number | null;
  errorType: string | null;
  errorMessage: string | null;
  /** FastTest's own error body, when it returned one. Never contains credentials. */
  errorBody: unknown;
  url: string | null;
  correlationId: string | null;
  data: unknown;
}

export interface ManualVerificationInput {
  testCode: string;
  workspaceId?: string | null;
  /** Granted by manual_verification.view_sensitive — otherwise values are masked. */
  revealSensitive?: boolean;
  /** Recorded in the history row so every check is attributable. */
  userId?: string;
}

const SENSITIVE_FIELDS = ['accessToken', 'proctorCode'] as const;

function s(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  return String(v);
}

function normName(v: string | null): string {
  return (v ?? '').toLowerCase().replace(/[^a-z؀-ۿ]+/gi, ' ').trim().replace(/\s+/g, ' ');
}

/** Loose name match: same tokens in any order, ignoring case/punctuation. */
function namesApproximatelyMatch(a: string | null, b: string | null): boolean {
  const ta = normName(a).split(' ').filter(Boolean);
  const tb = normName(b).split(' ').filter(Boolean);
  if (!ta.length || !tb.length) return false;
  const [short, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  const hits = short.filter((t) => long.includes(t)).length;
  return hits / short.length >= 0.5;
}

function outcomeFrom(probe: ProbeResult): EndpointOutcome {
  return {
    success: probe.ok,
    httpCode: probe.httpCode,
    latencyMs: probe.latencyMs,
    errorType: probe.error?.errorType ?? null,
    errorMessage: probe.error?.message ?? null,
    errorBody: probe.error
      ? { code: probe.error.fastTestErrorCode ?? null, message: probe.error.fastTestErrorMessage ?? null }
      : null,
    url: probe.url,
    correlationId: probe.correlationId,
    data: probe.ok ? probe.data : null,
  };
}

/** Human-readable explanation per failure mode, so the UI never shows a bare code. */
export function explainFailure(errorType: string | null, httpCode: number | null): string | null {
  switch (errorType) {
    case SYNC_ERROR.NOT_FOUND:
      return httpCode === 404
        ? 'FastTest has no data at this endpoint for this code yet.'
        : 'FastTest returned no registration for this code.';
    case SYNC_ERROR.UNAUTHORIZED:
      return httpCode === 403
        ? 'The workspace credentials are not permitted to read this registration — it may belong to a different workspace.'
        : 'FastTest rejected the token. It was refreshed and retried once.';
    case SYNC_ERROR.AUTH_FAILED:
      return 'Could not authenticate with this workspace. Check its REST API key / credentials in Integration settings.';
    case SYNC_ERROR.RATE_LIMITED:
      return 'FastTest is rate-limiting this workspace (HTTP 429). Wait a moment and retry.';
    case SYNC_ERROR.SERVER_ERROR:
      return 'FastTest returned a server error (5xx). This is on their side; retry shortly.';
    case SYNC_ERROR.TIMEOUT:
      return 'FastTest did not respond within the request timeout.';
    case SYNC_ERROR.CONNECTION_FAILURE:
      return 'Network or TLS failure reaching FastTest.';
    case SYNC_ERROR.INVALID_RESPONSE:
      return 'FastTest returned a response this dashboard could not parse.';
    default:
      return null;
  }
}

/** Every local field the page displays, with sensitive values masked unless allowed. */
function buildLocalRecord(reg: any, school: any, student: any, workspaceName: string | null, reveal: boolean) {
  const mask = (v: string | null) => (v == null ? null : reveal ? v : maskSecret(v) || '********');
  return {
    studentId: s(reg.studentExternalId),
    internalStudentId: s(reg.studentId),
    emiratesId: s(reg.emiratesId ?? student?.emiratesId),
    nameArabic: s(student?.nameArabic),
    nameEnglish: s(student?.nameEnglish),
    schoolId: s(reg.schoolId),
    schoolExternalId: s(school?.externalId),
    schoolName: s(school?.name),
    grade: s(reg.grade),
    classCode: s(reg.classCode),
    examSubject: s(reg.examSubject),
    examName: s(reg.examName),
    startDate: s(reg.startDate),
    endDate: s(reg.endDate),
    startTime: s(reg.startTime),
    endTime: s(reg.endTime),
    testCode: s(reg.testCodeOriginal),
    testCodeNormalized: s(reg.testCodeNormalized),
    proctorCode: mask(s(reg.proctorCode)),
    accessToken: mask(s(reg.accessToken)),
    academicYear: s(reg.academicYear),
    programType: s(reg.programType),
    attendance: s(reg.attendanceOriginal),
    workspaceId: s(reg.workspaceId),
    workspaceName,
    dashboardStatus: s(reg.dashboardStatus),
    fastTestStatus: s(reg.fastTestStatus),
    secondsUsed: reg.secondsUsed ?? null,
    actualStartTimeRaw: s(reg.actualStartTime),
    actualStartTimeLocal: formatInZone(reg.actualStartTimeUtc, env.displayTimezone),
    actualStartTimeResolution: s(reg.actualStartTimeResolution),
    lastSyncAt: reg.lastSyncAt ? reg.lastSyncAt.toISOString() : null,
    lastSuccessfulSyncAt: reg.lastSuccessfulSyncAt ? reg.lastSuccessfulSyncAt.toISOString() : null,
    syncStatus: s(reg.syncStatus),
    syncState: s(reg.syncState),
    syncError: s(reg.syncError),
    syncRetryCount: reg.syncRetryCount ?? 0,
    isStale: !!reg.isStale,
    staleReason: s(reg.staleReason),
    /** Which keys were masked, so the UI can offer a reveal affordance. */
    _sensitiveFields: SENSITIVE_FIELDS.filter((f) => s(reg[f]) !== null),
    _sensitiveRevealed: reveal,
  };
}

export interface ManualVerificationResult {
  success: boolean;
  originalTestCode: string;
  normalizedTestCode: string;
  workspace: { id: string; name: string; subject: string; resolvedBy: string } | null;
  workspaceError: string | null;
  localRecord: ReturnType<typeof buildLocalRecord> | null;
  localRecordFound: boolean;
  fastTest: { status: EndpointOutcome; results: EndpointOutcome };
  calculated: Record<string, unknown> | null;
  examTime: ReturnType<typeof buildExamTime> | null;
  comparisons: Comparison[];
  checkedAt: string;
  correlationId: string;
  error: string | null;
}

export async function verifyTestCode(
  input: ManualVerificationInput,
  client: FastTestClient = fastTestClient,
): Promise<ManualVerificationResult> {
  const correlationId = uuid();
  const originalTestCode = (input.testCode ?? '').trim();
  const normalizedTestCode = normalizeTestCode(originalTestCode);
  const reveal = !!input.revealSensitive;

  const emptyOutcome: EndpointOutcome = {
    success: false, httpCode: null, latencyMs: null, errorType: null,
    errorMessage: null, errorBody: null, url: null, correlationId: null, data: null,
  };

  const base: ManualVerificationResult = {
    success: false,
    originalTestCode,
    normalizedTestCode,
    workspace: null,
    workspaceError: null,
    localRecord: null,
    localRecordFound: false,
    fastTest: { status: { ...emptyOutcome }, results: { ...emptyOutcome } },
    calculated: null,
    examTime: null,
    comparisons: [],
    checkedAt: new Date().toISOString(),
    correlationId,
    error: null,
  };

  if (!normalizedTestCode) {
    return { ...base, error: 'Enter a Test Code.' };
  }

  // ---- 1. Local record (read-only) ---------------------------------------
  const reg = await prisma.examRegistration.findFirst({
    where: { testCodeNormalized: normalizedTestCode, deletedAt: null },
    orderBy: { updatedAt: 'desc' },
  });
  let school: any = null;
  let student: any = null;
  if (reg) {
    [school, student] = await Promise.all([
      reg.schoolId ? prisma.school.findUnique({ where: { id: reg.schoolId } }) : Promise.resolve(null),
      reg.studentId ? prisma.student.findUnique({ where: { id: reg.studentId } }) : Promise.resolve(null),
    ]);
  }

  // ---- 2. Workspace resolution -------------------------------------------
  let ws: ResolvedWorkspace | null = null;
  let resolvedBy = '';
  if (input.workspaceId) {
    ws = await getWorkspaceById(input.workspaceId);
    resolvedBy = 'manual override';
    if (!ws) base.workspaceError = 'The selected workspace does not exist.';
  } else if (reg?.workspaceId) {
    ws = await getWorkspaceById(reg.workspaceId);
    resolvedBy = 'local registration';
  }
  if (!ws && !input.workspaceId && reg?.examSubject) {
    ws = await resolveWorkspaceBySubject(reg.examSubject);
    if (ws) resolvedBy = `ExamSubject mapping (${reg.examSubject})`;
  }
  if (!ws && !base.workspaceError) {
    base.workspaceError = reg
      ? 'No workspace is mapped to this registration’s ExamSubject. Select one manually.'
      : 'This Test Code is not in the local database, so its workspace cannot be inferred. Select one manually.';
  }

  base.localRecordFound = !!reg;
  if (reg) base.localRecord = buildLocalRecord(reg, school, student, ws?.workspaceName ?? null, reveal);

  if (!ws) {
    await saveHistory(base, input, null);
    return { ...base, error: base.workspaceError };
  }
  base.workspace = {
    id: ws.workspaceId, name: ws.workspaceName, subject: ws.subjectCode, resolvedBy,
  };

  // ---- 3+4. Both lookups, independently ----------------------------------
  // Sequential rather than parallel so the first call warms the token cache and
  // the second reuses it, instead of two concurrent auth attempts.
  const statusProbe = await client.probeStatus(ws, normalizedTestCode);
  base.fastTest.status = outcomeFrom(statusProbe);

  const resultsProbe = await client.probeResults(ws, normalizedTestCode);
  base.fastTest.results = outcomeFrom(resultsProbe);

  // ---- 5+6. Merge and derive ---------------------------------------------
  const statusData: any = statusProbe.ok ? statusProbe.data : null;
  const resultsData: any = resultsProbe.ok ? resultsProbe.data : null;
  const parsed = resultsData ? safeParseResults(resultsData) : null;

  base.calculated = buildCalculated(parsed, statusData);
  base.examTime = buildExamTime(parsed, reg, ws);
  base.comparisons = buildComparisons({ reg, student, statusData, parsed, ws, base });
  base.success = statusProbe.ok || resultsProbe.ok || !!reg;
  if (!statusProbe.ok && !resultsProbe.ok && !reg) {
    base.error = base.fastTest.status.errorMessage ?? 'Nothing found for this Test Code.';
  }

  await saveHistory(base, input, ws);
  return base;
}

function safeParseResults(payload: unknown) {
  try {
    return parseResults(payload);
  } catch (e) {
    logger.warn({ err: (e as Error).message }, 'manual-verification: unparseable results payload');
    return null;
  }
}

/** Section F — values derived from what FastTest returned. Never persisted. */
function buildCalculated(parsed: ReturnType<typeof safeParseResults>, statusData: any): Record<string, unknown> | null {
  if (!parsed && !statusData) return null;
  const primary = parsed?.scores?.[0];
  const correct = primary?.correct ?? primary?.totalCorrect;
  const incorrect = primary?.incorrect ?? primary?.totalIncorrect;
  const skipped = primary?.skipped ?? primary?.totalSkipped;
  const attempted = correct != null && incorrect != null ? correct + incorrect : parsed?.attemptedItems ?? null;
  const totalItems = correct != null && incorrect != null && skipped != null
    ? correct + incorrect + skipped
    : parsed?.totalItemsCount ?? null;
  return {
    attempted,
    totalItems,
    correct: correct ?? null,
    incorrect: incorrect ?? null,
    skipped: skipped ?? null,
    completionPercentage: parsed?.completionPercentage
      ?? (attempted != null && totalItems ? Math.round((attempted / totalItems) * 10000) / 100 : null),
    secondsUsed: parsed?.secondsUsed ?? null,
    formattedDuration: parsed?.durationFormatted ?? formatDuration(parsed?.secondsUsed) ?? null,
    dashboardStatus: statusData?.status ? toDashboardStatus(String(statusData.status)) : null,
  };
}

/**
 * FastTest records exam times on a US clock and sends them with no timezone and
 * no AM/PM marker. Report the raw string, the converted UAE instant, and how it
 * was arrived at — an operator verifying one student needs to see when the exam
 * actually started locally, and to be told when that could not be determined.
 */
function buildExamTime(parsed: ReturnType<typeof safeParseResults>, reg: any, ws: ResolvedWorkspace | null) {
  const r = resolveExamTime({
    raw: parsed?.startTime,
    sourceTimeZone: ws?.sourceTimeZone ?? env.fasttest.sourceTimezone,
    displayTimeZone: env.displayTimezone,
    windowStart: reg?.startTime,
    windowEnd: reg?.endTime,
  });
  const trustworthy = RESOLVED_STATES.includes(r.resolution);
  return {
    raw: r.raw,
    sourceTimeZone: r.sourceTimeZone,
    displayTimeZone: env.displayTimezone,
    localStart: r.displayLocal,
    localHour: r.displayHour,
    resolution: r.resolution,
    trustworthy,
    note: trustworthy
      ? `FastTest sent "${r.raw}" on its ${r.sourceTimeZone} clock with no timezone or AM/PM marker; converted to ${env.displayTimezone}.`
      : 'FastTest sent a clock reading that could not be placed in the exam window — the true start time is unknown.',
  };
}

function verdictRow(
  key: string, label: string, local: string | null, fastTest: string | null,
  compare: (l: string, f: string) => ComparisonVerdict, note?: string,
): Comparison {
  if (local == null || fastTest == null) {
    return { key, label, verdict: 'NOT_ENOUGH_DATA', local, fastTest, note };
  }
  return { key, label, verdict: compare(local, fastTest), local, fastTest, note };
}

function buildComparisons(ctx: {
  reg: any; student: any; statusData: any;
  parsed: ReturnType<typeof safeParseResults>; ws: ResolvedWorkspace; base: ManualVerificationResult;
}): Comparison[] {
  const { reg, student, statusData, parsed, ws, base } = ctx;
  const out: Comparison[] = [];
  const eq = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

  // Existence on each side.
  const inFastTest = base.fastTest.status.success || base.fastTest.results.success;
  out.push({
    key: 'existence',
    label: 'Record exists locally and in FastTest',
    verdict: reg && inFastTest ? 'MATCH' : (!reg && !inFastTest ? 'NOT_ENOUGH_DATA' : 'WARNING'),
    local: reg ? 'found' : 'not found',
    fastTest: inFastTest ? 'found' : 'not found',
    note: reg && !inFastTest
      ? 'Exists locally but FastTest returned nothing — it may never have been scheduled there.'
      : (!reg && inFastTest ? 'Exists in FastTest but not in this dashboard — it was never imported.' : undefined),
  });

  const ftName = s(parsed?.testName) ?? s(statusData?.testName);
  out.push(verdictRow('examName', 'FastTest test name vs local ExamName',
    s(reg?.examName), ftName,
    (l, f) => (eq(l, f) ? 'MATCH' : (normName(l) && normName(f).includes(normName(l).split(' ')[0]) ? 'WARNING' : 'MISMATCH'))));

  const ftExternal = s(statusData?.externalId) ?? s(parsed?.externalId);
  const localIds = [s(reg?.emiratesId), s(reg?.studentExternalId)].filter(Boolean) as string[];
  out.push({
    key: 'externalId',
    label: 'FastTest externalId vs local EmiratesId / StudentId',
    verdict: !ftExternal || !localIds.length
      ? 'NOT_ENOUGH_DATA'
      : (localIds.some((id) => eq(id, ftExternal)) ? 'MATCH' : 'MISMATCH'),
    local: localIds.join(' / ') || null,
    fastTest: ftExternal,
  });

  const ftFullName = [s(statusData?.firstName) ?? s(parsed?.firstName), s(statusData?.lastName) ?? s(parsed?.lastName)]
    .filter(Boolean).join(' ') || null;
  const localName = s(student?.nameEnglish) ?? s(student?.nameArabic);
  out.push(verdictRow('studentName', 'Student name (approximate)', localName, ftFullName,
    (l, f) => (eq(l, f) ? 'MATCH' : (namesApproximatelyMatch(l, f) ? 'WARNING' : 'MISMATCH')),
    'Names are compared loosely — transliteration differences are expected.'));

  // Subject → workspace mapping correctness.
  const localSubject = s(reg?.examSubject);
  out.push({
    key: 'workspaceMapping',
    label: 'Subject / workspace mapping',
    verdict: !reg ? 'NOT_ENOUGH_DATA'
      : (reg.workspaceId && reg.workspaceId !== ws.workspaceId ? 'WARNING' : 'MATCH'),
    local: localSubject,
    fastTest: `${ws.workspaceName} [${ws.subjectCode}]`,
    note: reg?.workspaceId && reg.workspaceId !== ws.workspaceId
      ? 'The registration is assigned to a different workspace than the one queried.'
      : undefined,
  });

  // Attendance vs live status.
  const attendance = s(reg?.attendanceOriginal);
  const live = statusData?.status ? toDashboardStatus(String(statusData.status)) : null;
  const absent = attendance ? /absent|غائب/i.test(attendance) : false;
  const sat = live === 'COMPLETED' || live === 'IN_PROGRESS';
  out.push({
    key: 'attendance',
    label: 'Local attendance vs FastTest status',
    verdict: !attendance || !live ? 'NOT_ENOUGH_DATA' : (absent && sat ? 'MISMATCH' : 'MATCH'),
    local: attendance,
    fastTest: live,
    note: absent && sat ? 'Marked absent locally but FastTest shows the student sat the exam.' : undefined,
  });

  // Stored status vs live status.
  out.push(verdictRow('status', 'Stored status vs FastTest status',
    s(reg?.dashboardStatus), live, (l, f) => (eq(l, f) ? 'MATCH' : 'MISMATCH'),
    'A difference here means the local record is behind — run a sync to refresh it.'));

  return out;
}

/**
 * Persist the attempt. Stores outcomes and timings only — never tokens, API
 * keys or credentials, and never the API payloads themselves.
 */
async function saveHistory(
  result: ManualVerificationResult,
  input: ManualVerificationInput,
  ws: ResolvedWorkspace | null,
): Promise<void> {
  const errors = [
    result.workspaceError,
    result.fastTest.status.success ? null : result.fastTest.status.errorMessage,
    result.fastTest.results.success ? null : result.fastTest.results.errorMessage,
  ].filter(Boolean);
  try {
    await prisma.manualVerificationLog.create({
      data: {
        originalTestCode: result.originalTestCode.slice(0, 190),
        normalizedTestCode: result.normalizedTestCode.slice(0, 190),
        workspaceId: ws?.workspaceId ?? null,
        localRecordFound: result.localRecordFound,
        statusRequestSuccess: result.fastTest.status.success,
        resultsRequestSuccess: result.fastTest.results.success,
        fastTestStatus: s((result.fastTest.status.data as any)?.status),
        statusHttpCode: result.fastTest.status.httpCode,
        resultsHttpCode: result.fastTest.results.httpCode,
        statusLatencyMs: result.fastTest.status.latencyMs,
        resultsLatencyMs: result.fastTest.results.latencyMs,
        requestedByUserId: input.userId ?? null,
        correlationId: result.correlationId,
        errorSummary: errors.length ? errors.join(' | ').slice(0, 1000) : null,
      },
    });
  } catch (e) {
    logger.warn({ err: (e as Error).message }, 'failed to persist manual verification history');
  }
}

/** Recent checks for the same Test Code (most recent first). */
export async function recentChecks(normalizedTestCode: string, limit = 10) {
  const rows = await prisma.manualVerificationLog.findMany({
    where: { normalizedTestCode },
    orderBy: { createdAt: 'desc' },
    take: limit,
    include: { user: { select: { email: true } }, workspace: { select: { workspaceName: true } } },
  });
  return rows.map((r) => ({
    id: r.id,
    createdAt: r.createdAt.toISOString(),
    by: r.user?.email ?? null,
    workspace: r.workspace?.workspaceName ?? null,
    localRecordFound: r.localRecordFound,
    statusRequestSuccess: r.statusRequestSuccess,
    resultsRequestSuccess: r.resultsRequestSuccess,
    fastTestStatus: r.fastTestStatus,
    statusHttpCode: r.statusHttpCode,
    resultsHttpCode: r.resultsHttpCode,
    statusLatencyMs: r.statusLatencyMs,
    resultsLatencyMs: r.resultsLatencyMs,
    errorSummary: r.errorSummary,
    correlationId: r.correlationId,
  }));
}

export { FastTestApiError };
