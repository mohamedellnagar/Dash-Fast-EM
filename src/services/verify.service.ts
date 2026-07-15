import { prisma } from '../db/prisma';
import { normalizeTestCode } from '../lib/testcode';
import { toDashboardStatus } from '../lib/enums';
import { resolveWorkspaceBySubject } from './workspace.service';
import { FastTestClient, FastTestApiError, fastTestClient } from './fasttest/client';
import { parseResults } from './fasttest/results-mapper';

// Read-only verification probe. Given a TestCode + ExamName, it resolves the
// FastTest workspace, fetches the LIVE status (and results when completed), and
// — if a matching registration already exists locally — compares the two.
// It NEVER writes anything: no registration is created, no snapshot persisted.
// Purpose: confirm a code's sync/data without touching the database.

export interface VerifyInput {
  testCode: string;
  examName: string;
}

export interface VerifyFieldDiff {
  field: string;
  live: string | null;
  stored: string | null;
  match: boolean;
}

export interface VerifyResult {
  ok: boolean;
  // Inputs (echoed, normalized)
  testCodeInput: string;
  testCodeNormalized: string | null;
  examName: string;
  // Resolution
  workspace: { id: string; name: string; subjectCode: string } | null;
  // Live FastTest data
  liveStatusRaw: string | null;
  liveDashboardStatus: string | null;
  liveExaminee: { firstName?: string; lastName?: string; externalId?: string; examineeId?: string } | null;
  liveResultSummary: {
    testName?: string | null;
    startTime?: string | null;
    secondsUsed?: number | null;
    passed?: boolean | null;
    rawScore?: number | null;
    scaledScore?: number | null;
    correct?: number | null;
    incorrect?: number | null;
    skipped?: number | null;
  } | null;
  liveRawStatusJson: string | null;
  liveRawResultsJson: string | null;
  // Local comparison (read-only)
  existsInDb: boolean;
  storedSummary: {
    dashboardStatus?: string | null;
    examSubject?: string | null;
    examName?: string | null;
    secondsUsed?: number | null;
    lastSuccessfulSyncAt?: string | null;
  } | null;
  diffs: VerifyFieldDiff[];
  inSync: boolean | null; // true/false when a DB record exists; null when it does not
  // Diagnostics
  error: string | null;
  errorType: string | null;
}

function s(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  return String(v);
}

export async function verifyByCode(input: VerifyInput, client: FastTestClient = fastTestClient): Promise<VerifyResult> {
  const testCodeInput = (input.testCode ?? '').trim();
  const examName = (input.examName ?? '').trim();
  const normalized = normalizeTestCode(testCodeInput);

  const base: VerifyResult = {
    ok: false,
    testCodeInput,
    testCodeNormalized: normalized || null,
    examName,
    workspace: null,
    liveStatusRaw: null,
    liveDashboardStatus: null,
    liveExaminee: null,
    liveResultSummary: null,
    liveRawStatusJson: null,
    liveRawResultsJson: null,
    existsInDb: false,
    storedSummary: null,
    diffs: [],
    inSync: null,
    error: null,
    errorType: null,
  };

  if (!normalized) return { ...base, error: 'Invalid TestCode', errorType: 'INVALID_TESTCODE' };
  if (!examName) return { ...base, error: 'ExamName is required', errorType: 'MISSING_EXAM_NAME' };

  // Resolve workspace by ExamName (alias mapping, then subjectCode fallback).
  const ws = await resolveWorkspaceBySubject(examName);
  if (!ws) {
    return { ...base, error: `No active FastTest workspace resolves ExamName "${examName}"`, errorType: 'WORKSPACE_NOT_FOUND' };
  }
  base.workspace = { id: ws.workspaceId, name: ws.workspaceName, subjectCode: ws.subjectCode };

  // Live status (read-only against FastTest).
  try {
    const status = await client.getStatus(ws, normalized);
    base.liveStatusRaw = s(status.status);
    base.liveDashboardStatus = toDashboardStatus(status.status as string);
    base.liveExaminee = {
      firstName: s(status.firstName) ?? undefined,
      lastName: s(status.lastName) ?? undefined,
      externalId: s(status.externalId) ?? undefined,
      examineeId: s(status.examineeId) ?? undefined,
    };
    base.liveRawStatusJson = JSON.stringify(status, null, 2);

    // Fetch results only when completed.
    if (base.liveDashboardStatus === 'COMPLETED') {
      const payload = await client.getResults(ws, normalized);
      const parsed = parseResults(payload);
      const primary = parsed.scores[0];
      base.liveResultSummary = {
        testName: parsed.testName ?? null,
        startTime: parsed.startTime ?? null,
        secondsUsed: parsed.secondsUsed ?? null,
        passed: parsed.passed ?? null,
        rawScore: primary?.rawScore ?? null,
        scaledScore: primary?.scaledScore ?? null,
        correct: primary?.correct ?? null,
        incorrect: primary?.incorrect ?? null,
        skipped: primary?.skipped ?? null,
      };
      base.liveRawResultsJson = JSON.stringify(payload, null, 2);
    }
    base.ok = true;
  } catch (e: any) {
    const errType = e instanceof FastTestApiError ? e.errorType : (e?.code ?? 'ERROR');
    return { ...base, error: e?.message ?? 'FastTest request failed', errorType: errType };
  }

  // Read-only local lookup + comparison (never writes).
  const reg = await prisma.examRegistration.findFirst({
    where: { testCodeNormalized: normalized, deletedAt: null },
    orderBy: { updatedAt: 'desc' },
  });

  if (reg) {
    base.existsInDb = true;
    base.storedSummary = {
      dashboardStatus: reg.dashboardStatus ?? null,
      examSubject: reg.examSubject ?? null,
      examName: reg.examName ?? null,
      secondsUsed: reg.secondsUsed ?? null,
      lastSuccessfulSyncAt: reg.lastSuccessfulSyncAt ? reg.lastSuccessfulSyncAt.toISOString() : null,
    };

    const diffs: VerifyFieldDiff[] = [];
    const add = (field: string, live: unknown, stored: unknown) => {
      const l = s(live);
      const st = s(stored);
      diffs.push({ field, live: l, stored: st, match: l === st });
    };
    add('Status', base.liveDashboardStatus, reg.dashboardStatus);
    if (base.liveResultSummary) {
      add('Seconds Used', base.liveResultSummary.secondsUsed, reg.secondsUsed);
    }
    base.diffs = diffs;
    base.inSync = diffs.every((d) => d.match);
  }

  return base;
}
