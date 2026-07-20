import * as XLSX from 'xlsx';
import { prisma } from '../../db/prisma';
import { buildTestCode } from '../../lib/testcode';
import { logger } from '../../lib/logger';
import { normalizeGrade } from '../../lib/grade';
import { normalizeAlias, resolveWorkspaceBySubject } from '../workspace.service';

// Columns expected in the source template. Matching is case/space-insensitive.
export const REQUIRED_COLUMNS = ['StudentId', 'ExamSubject', 'TestCode'] as const;
export const KNOWN_COLUMNS = [
  'StudentId', 'NameArabic', 'NameEnglish', 'SchoolId', 'SchoolName', 'Grade',
  'EmiratesId', 'ClassCode', 'ExamSubject', 'ExamName', 'StartDate', 'EndDate',
  'StartTime', 'EndTime', 'TestCode', 'ProctorCode', 'AccessToken', 'AcademicYear',
  'Attendance',
] as const;

export interface RawRow {
  [k: string]: string;
}

export interface RowError {
  rowNumber: number;
  column?: string;
  value?: string;
  message: string;
}

export interface ValidatedRow {
  rowNumber: number;
  data: Record<string, string>;
  testCodeOriginal: string;
  testCodeNormalized: string;
}

export interface ValidationOutcome {
  validRows: ValidatedRow[];
  errors: RowError[];
  totalRows: number;
}

function canon(key: string): string {
  return key.replace(/[\s_]/g, '').toLowerCase();
}

/** Map arbitrary header casing/spacing to the known column names. */
function buildHeaderMap(headers: string[]): Record<string, string> {
  const map: Record<string, string> = {};
  const known = new Map(KNOWN_COLUMNS.map((c) => [canon(c), c]));
  for (const h of headers) {
    const target = known.get(canon(h));
    if (target) map[h] = target;
  }
  return map;
}

/** Parse an uploaded CSV/XLSX buffer into raw rows keyed by canonical columns. */
export function parseFile(buffer: Buffer): { rows: RawRow[]; missingColumns: string[] } {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const raw: Record<string, any>[] = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });
  if (raw.length === 0) return { rows: [], missingColumns: [...REQUIRED_COLUMNS] };

  const headers = Object.keys(raw[0]);
  const headerMap = buildHeaderMap(headers);
  const presentCanonical = new Set(Object.values(headerMap).map(canon));
  const missingColumns = REQUIRED_COLUMNS.filter((c) => !presentCanonical.has(canon(c)));

  const rows: RawRow[] = raw.map((r) => {
    const out: RawRow = {};
    for (const [orig, target] of Object.entries(headerMap)) {
      out[target] = String(r[orig] ?? '').trim();
    }
    return out;
  });
  return { rows, missingColumns };
}

function isValidDate(s: string): boolean {
  if (!s) return true; // optional
  const str = s.trim();
  // Day/month/year (e.g. "22/09/2025" or "22/09/2025 0:00"), with / . or -
  // separators. Native Date.parse mis-reads these as month/day, so validate
  // the calendar ranges ourselves. The original string is stored verbatim.
  const dmy = str.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?$/);
  if (dmy) {
    const day = Number(dmy[1]);
    const month = Number(dmy[2]);
    return day >= 1 && day <= 31 && month >= 1 && month <= 12;
  }
  // ISO and other natively-parseable formats (e.g. "2025-09-22").
  return !Number.isNaN(Date.parse(str));
}

/** Validate rows, producing per-row errors and a clean set for upsert. */
export function validateRows(rows: RawRow[]): ValidationOutcome {
  const errors: RowError[] = [];
  const validRows: ValidatedRow[] = [];
  const seen = new Set<string>();

  rows.forEach((row, idx) => {
    const rowNumber = idx + 2; // +1 header, +1 for 1-based
    const rowErrors: RowError[] = [];

    for (const col of REQUIRED_COLUMNS) {
      if (!row[col] || row[col].trim() === '') {
        rowErrors.push({ rowNumber, column: col, message: `${col} is required` });
      }
    }

    const tc = buildTestCode(row.TestCode);
    if (row.TestCode && tc.testCodeNormalized.length < 3) {
      rowErrors.push({ rowNumber, column: 'TestCode', value: row.TestCode, message: 'TestCode looks invalid after normalization' });
    }

    for (const dcol of ['StartDate', 'EndDate']) {
      if (row[dcol] && !isValidDate(row[dcol])) {
        rowErrors.push({ rowNumber, column: dcol, value: row[dcol], message: `${dcol} is not a valid date` });
      }
    }

    // Duplicate detection within the file (StudentId + ExamSubject + TestCode).
    const dupKey = `${row.StudentId}::${normalizeAlias(row.ExamSubject)}::${tc.testCodeNormalized}`;
    if (row.StudentId && row.ExamSubject && tc.testCodeNormalized) {
      if (seen.has(dupKey)) {
        rowErrors.push({ rowNumber, message: `Duplicate row for StudentId/ExamSubject/TestCode within file` });
      }
      seen.add(dupKey);
    }

    if (rowErrors.length) {
      errors.push(...rowErrors);
    } else {
      validRows.push({ rowNumber, data: row, testCodeOriginal: tc.testCodeOriginal, testCodeNormalized: tc.testCodeNormalized });
    }
  });

  return { validRows, errors, totalRows: rows.length };
}

export interface ImportSummary {
  importJobId: string;
  totalRows: number;
  created: number;
  updated: number;
  skipped: number;
  failed: number;
  errors: RowError[];
  unresolvedSubjects: string[];
}

/**
 * Commit validated rows via upsert. Matching key: StudentId + ExamSubject +
 * TestCode (normalized). Preserves attendanceOriginal; resolves workspace by
 * subject where possible (unresolved subjects are recorded, not fabricated).
 */
export async function commitImport(
  fileName: string,
  outcome: ValidationOutcome,
  userId?: string,
  preview = false,
  programType?: string | null,
): Promise<ImportSummary> {
  const job = await prisma.importJob.create({
    data: {
      userId: userId ?? null,
      fileName,
      status: preview ? 'PREVIEW' : 'COMPLETED',
      totalRows: outcome.totalRows,
    },
  });

  // Persist validation errors.
  if (outcome.errors.length) {
    await prisma.importError.createMany({
      data: outcome.errors.map((e) => ({
        importJobId: job.id,
        rowNumber: e.rowNumber,
        column: e.column ?? null,
        value: e.value ?? null,
        message: e.message,
      })),
    });
  }

  let created = 0;
  let updated = 0;
  let skipped = 0;
  let failed = 0;
  const unresolvedSubjects = new Set<string>();

  if (!preview) {
    for (const vr of outcome.validRows) {
      try {
        const r = vr.data;
        const school = r.SchoolId
          ? await upsertSchool(r.SchoolId, r.SchoolName)
          : null;
        const student = await upsertStudent(r, school?.id);
        const subject = r.ExamSubject ? await upsertSubject(r.ExamSubject) : null;
        // Workspace / FastTest API routing is resolved by ExamName (not
        // ExamSubject). ExamSubject is kept only for analytics/grouping.
        const ws = r.ExamName ? await resolveWorkspaceBySubject(r.ExamName) : null;
        if (!ws) unresolvedSubjects.add(r.ExamName || r.ExamSubject);

        const existing = await prisma.examRegistration.findFirst({
          where: {
            studentExternalId: r.StudentId,
            examSubject: r.ExamSubject,
            testCodeNormalized: vr.testCodeNormalized,
          },
        });

        const baseData = {
          studentExternalId: r.StudentId,
          studentId: student?.id ?? null,
          schoolId: school?.id ?? null,
          subjectId: subject?.id ?? null,
          examSubject: r.ExamSubject,
          examName: r.ExamName || null,
          programType: programType || null,
          grade: normalizeGrade(r.Grade),
          classCode: r.ClassCode || null,
          startDate: r.StartDate || null,
          endDate: r.EndDate || null,
          startTime: r.StartTime || null,
          endTime: r.EndTime || null,
          academicYear: r.AcademicYear || null,
          proctorCode: r.ProctorCode || null,
          accessToken: r.AccessToken || null,
          testCodeOriginal: vr.testCodeOriginal,
          testCodeNormalized: vr.testCodeNormalized,
          attendanceOriginal: r.Attendance || null,
          emiratesId: r.EmiratesId || null, // denormalized for fast unique-student counts
          workspaceId: ws?.workspaceId ?? null,
        };

        if (existing) {
          // Never overwrite attendanceOriginal once set from source.
          const { attendanceOriginal, ...rest } = baseData;
          await prisma.examRegistration.update({
            where: { id: existing.id },
            data: existing.attendanceOriginal ? rest : baseData,
          });
          updated++;
        } else {
          await prisma.examRegistration.create({ data: baseData });
          created++;
        }
      } catch (e) {
        failed++;
        await prisma.importError.create({
          data: { importJobId: job.id, rowNumber: vr.rowNumber, message: `Upsert failed: ${(e as Error).message}` },
        });
        logger.warn({ row: vr.rowNumber, err: (e as Error).message }, 'import row upsert failed');
      }
    }
  } else {
    skipped = outcome.validRows.length;
  }

  const summary: ImportSummary = {
    importJobId: job.id,
    totalRows: outcome.totalRows,
    created,
    updated,
    skipped,
    failed: failed + (preview ? 0 : 0),
    errors: outcome.errors,
    unresolvedSubjects: [...unresolvedSubjects],
  };

  // Keep the persisted summary bounded: errors live in the ImportError table,
  // and unresolved names can be very large (e.g. before workspaces are mapped),
  // so cap the list and record the true count instead of serializing them all.
  const UNRESOLVED_CAP = 100;
  const persistedSummary = {
    ...summary,
    errors: undefined,
    unresolvedSubjectsCount: summary.unresolvedSubjects.length,
    unresolvedSubjects: summary.unresolvedSubjects.slice(0, UNRESOLVED_CAP),
  };
  await prisma.importJob.update({
    where: { id: job.id },
    data: {
      createdCount: created,
      updatedCount: updated,
      skippedCount: skipped,
      failedCount: outcome.errors.length + failed,
      summaryJson: JSON.stringify(persistedSummary),
    },
  });

  return summary;
}

async function upsertSchool(externalId: string, name?: string) {
  return prisma.school.upsert({
    where: { externalId },
    create: { externalId, name: name || externalId },
    update: name ? { name } : {},
  });
}

async function upsertSubject(examSubject: string) {
  const code = normalizeAlias(examSubject).replace(/\s+/g, '_');
  return prisma.subject.upsert({
    where: { code },
    create: { code, name: examSubject },
    update: {},
  });
}

async function upsertStudent(r: RawRow, schoolId?: string) {
  return prisma.student.upsert({
    where: { externalId: r.StudentId },
    create: {
      externalId: r.StudentId,
      nameArabic: r.NameArabic || null,
      nameEnglish: r.NameEnglish || null,
      emiratesId: r.EmiratesId || null,
      grade: normalizeGrade(r.Grade),
      classCode: r.ClassCode || null,
      schoolId: schoolId ?? null,
    },
    update: {
      nameArabic: r.NameArabic || undefined,
      nameEnglish: r.NameEnglish || undefined,
      emiratesId: r.EmiratesId || undefined,
      grade: normalizeGrade(r.Grade) ?? undefined,
      classCode: r.ClassCode || undefined,
      schoolId: schoolId ?? undefined,
    },
  });
}
