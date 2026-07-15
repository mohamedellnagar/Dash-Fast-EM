import { prisma } from '../../src/db/prisma';
import { toDashboardStatus } from '../../src/lib/enums';

// Base is unique per module load so external ids never collide across the
// shared test database (tests run in a single fork, files load separately).
const BASE = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
let seq = 0;
function uniq(prefix: string) {
  seq += 1;
  return `${prefix}-${BASE}-${seq}`;
}

export interface RegSpec {
  studentExternalId?: string;
  schoolId?: string;
  subjectId?: string;
  examSubject?: string;
  grade?: string;
  status?: string; // dashboard status
  syncStatus?: string;
  syncError?: string;
  syncRetryCount?: number;
  lastSyncAt?: Date | null;
  attendance?: string;
  testCode?: string;
  linkStudent?: boolean;
  workspaceId?: string | null;
  startDate?: string;
  result?: {
    secondsUsed?: number;
    rawScore?: number;
    scaledScore?: number;
    correct?: number;
    incorrect?: number;
    skipped?: number;
    completionPercentage?: number;
  };
}

export async function makeSchool(name = uniq('School')) {
  return prisma.school.create({ data: { externalId: uniq('SCH'), name } });
}
export async function makeSubject(code = uniq('SUBJ').toUpperCase(), name = 'Subject') {
  return prisma.subject.create({ data: { code, name } });
}

/** Create a registration (and optional denormalized result) for analytics tests. */
export async function makeRegistration(spec: RegSpec = {}) {
  const testCode = spec.testCode ?? uniq('TC').toUpperCase();
  const normalized = testCode.replace(/[-\s]/g, '').toUpperCase();
  const status = spec.status ?? 'UNKNOWN';
  const reg = await prisma.examRegistration.create({
    data: {
      studentExternalId: spec.studentExternalId ?? uniq('STU'),
      studentId: spec.linkStudent === false ? null : (spec.studentId ?? null),
      schoolId: spec.schoolId ?? null,
      subjectId: spec.subjectId ?? null,
      examSubject: spec.examSubject ?? 'Test Subject',
      grade: spec.grade ?? '5',
      testCodeOriginal: testCode,
      testCodeNormalized: normalized,
      dashboardStatus: status,
      fastTestStatus: status,
      syncStatus: spec.syncStatus ?? 'PENDING',
      syncError: spec.syncError ?? null,
      syncRetryCount: spec.syncRetryCount ?? 0,
      lastSyncAt: spec.lastSyncAt === undefined ? null : spec.lastSyncAt,
      attendanceOriginal: spec.attendance ?? null,
      workspaceId: spec.workspaceId === undefined ? null : spec.workspaceId,
      startDate: spec.startDate ?? null,
      secondsUsed: spec.result?.secondsUsed ?? null,
    },
  });

  if (spec.result && spec.workspaceId) {
    const r = spec.result;
    const correct = r.correct ?? 0, incorrect = r.incorrect ?? 0, skipped = r.skipped ?? 0;
    await prisma.fastTestResult.create({
      data: {
        registrationId: reg.id, workspaceId: spec.workspaceId,
        secondsUsed: r.secondsUsed ?? null,
        rawScore: r.rawScore ?? null, scaledScore: r.scaledScore ?? null,
        correctCount: correct, incorrectCount: incorrect, skippedCount: skipped,
        attemptedItems: correct + incorrect, totalItemsCount: correct + incorrect + skipped,
        completionPercentage: r.completionPercentage ?? null,
        schoolId: spec.schoolId ?? null, subjectId: spec.subjectId ?? null,
        grade: spec.grade ?? null, examSubject: spec.examSubject ?? 'Test Subject',
        rawJson: '{}',
      },
    });
  }
  return reg;
}

/** Wipe registration-derived data between tests for isolation. */
export async function clearRegistrations() {
  await prisma.attentionNote.deleteMany({});
  await prisma.attentionItem.deleteMany({});
  await prisma.fastTestScore.deleteMany({});
  await prisma.fastTestResult.deleteMany({});
  await prisma.fastTestStatusSnapshot.deleteMany({});
  await prisma.examRegistration.deleteMany({});
}

export { toDashboardStatus };
