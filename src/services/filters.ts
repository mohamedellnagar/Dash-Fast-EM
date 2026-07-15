import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { SYNC_STATUS } from '../lib/enums';

// ---------------------------------------------------------------------------
// Advanced, server-side registration filters.
//
// All filtering happens in the database (never in the browser). The same
// filter object is reused by the registrations table, analytics endpoints,
// exports and saved views so KPIs always match the table.
// ---------------------------------------------------------------------------

const trimmed = z.string().trim().max(200);

export const advancedFilterSchema = z.object({
  studentId: trimmed.optional(),
  nameArabic: trimmed.optional(),
  nameEnglish: trimmed.optional(),
  emiratesId: trimmed.optional(),
  schoolId: trimmed.optional(),
  schoolName: trimmed.optional(),
  grade: trimmed.optional(),
  classCode: trimmed.optional(),
  subjectId: trimmed.optional(),
  examSubject: trimmed.optional(),
  examName: trimmed.optional(),
  testCode: trimmed.optional(),
  proctorCode: trimmed.optional(),
  academicYear: trimmed.optional(),
  programType: trimmed.optional(),
  attendance: trimmed.optional(),
  status: trimmed.optional(), // dashboardStatus (single or CSV)
  fastTestStatus: trimmed.optional(),
  syncStatus: trimmed.optional(),
  registrationDateFrom: trimmed.optional(),
  registrationDateTo: trimmed.optional(),
  actualStartFrom: trimmed.optional(),
  actualStartTo: trimmed.optional(),
  examStartFrom: trimmed.optional(),
  examStartTo: trimmed.optional(),
  examEndFrom: trimmed.optional(),
  examEndTo: trimmed.optional(),
  scoreMin: z.coerce.number().optional(),
  scoreMax: z.coerce.number().optional(),
  durationMin: z.coerce.number().int().optional(), // seconds
  durationMax: z.coerce.number().int().optional(),
  apiError: z.enum(['1', 'true', 'yes']).optional(),
  search: trimmed.optional(),
});

export type AdvancedFilter = z.infer<typeof advancedFilterSchema>;

/** Parse & validate an untrusted query object into a clean filter. */
export function parseFilter(query: Record<string, unknown>): AdvancedFilter {
  const cleaned: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== '') cleaned[k] = v;
  }
  return advancedFilterSchema.parse(cleaned);
}

function contains(v?: string) {
  return v ? { contains: v } : undefined;
}

/**
 * Build the Prisma where-clause. `scopeSchoolIds` is injected by the caller
 * from the authenticated principal and is ALWAYS ANDed in for school-scoped
 * users — it is never taken from user input.
 */
export function buildRegistrationWhere(
  f: AdvancedFilter,
  scopeSchoolIds?: string[],
): Prisma.ExamRegistrationWhereInput {
  const and: Prisma.ExamRegistrationWhereInput[] = [{ deletedAt: null }];

  // Hard school scoping (server-enforced, non-bypassable).
  if (scopeSchoolIds) and.push({ schoolId: { in: scopeSchoolIds.length ? scopeSchoolIds : ['__none__'] } });

  if (f.schoolId) and.push({ schoolId: f.schoolId });
  if (f.subjectId) and.push({ subjectId: f.subjectId });
  if (f.grade) and.push({ grade: f.grade });
  if (f.classCode) and.push({ classCode: contains(f.classCode) });
  if (f.examSubject) and.push({ examSubject: contains(f.examSubject) });
  if (f.examName) and.push({ examName: contains(f.examName) });
  if (f.testCode) and.push({ testCodeNormalized: { contains: f.testCode.replace(/[-\s]/g, '').toUpperCase() } });
  if (f.proctorCode) and.push({ proctorCode: contains(f.proctorCode) });
  if (f.academicYear) and.push({ academicYear: f.academicYear });
  if (f.programType) and.push({ programType: f.programType });
  if (f.attendance) and.push({ attendanceOriginal: contains(f.attendance) });
  if (f.studentId) and.push({ studentExternalId: { contains: f.studentId } });
  if (f.proctorCode) and.push({ proctorCode: contains(f.proctorCode) });

  if (f.status) {
    const list = f.status.split(',').map((s) => s.trim()).filter(Boolean);
    and.push(list.length > 1 ? { dashboardStatus: { in: list } } : { dashboardStatus: list[0] });
  }
  if (f.fastTestStatus) and.push({ fastTestStatus: f.fastTestStatus });
  if (f.syncStatus) and.push({ syncStatus: f.syncStatus });
  if (f.apiError) and.push({ syncStatus: { in: [SYNC_STATUS.ERROR, SYNC_STATUS.MANUAL_REVIEW] } });

  // Student relation filters
  const student: Prisma.StudentWhereInput = {};
  if (f.nameArabic) student.nameArabic = contains(f.nameArabic);
  if (f.nameEnglish) student.nameEnglish = contains(f.nameEnglish);
  if (f.emiratesId) student.emiratesId = contains(f.emiratesId);
  if (Object.keys(student).length) and.push({ student: { is: student } });

  if (f.schoolName) and.push({ school: { is: { name: contains(f.schoolName) } } });

  // Best-effort string date ranges (ISO strings compare lexically).
  pushRange(and, 'fastTestRegistrationDate', f.registrationDateFrom, f.registrationDateTo);
  pushRange(and, 'actualStartTime', f.actualStartFrom, f.actualStartTo);
  pushRange(and, 'startDate', f.examStartFrom, f.examStartTo);
  pushRange(and, 'endDate', f.examEndFrom, f.examEndTo);

  // Score / duration ranges via the (denormalized) results relation.
  const resultWhere: Prisma.FastTestResultWhereInput = {};
  if (f.scoreMin !== undefined || f.scoreMax !== undefined) {
    resultWhere.rawScore = rangeNum(f.scoreMin, f.scoreMax);
  }
  if (f.durationMin !== undefined || f.durationMax !== undefined) {
    resultWhere.secondsUsed = rangeNum(f.durationMin, f.durationMax);
  }
  if (Object.keys(resultWhere).length) and.push({ results: { some: resultWhere } });

  if (f.search) {
    and.push({
      OR: [
        { studentExternalId: { contains: f.search } },
        { testCodeOriginal: { contains: f.search } },
        { testCodeNormalized: { contains: f.search } },
        { examName: { contains: f.search } },
      ],
    });
  }

  return { AND: and };
}

function pushRange(
  and: Prisma.ExamRegistrationWhereInput[],
  field: 'fastTestRegistrationDate' | 'actualStartTime' | 'startDate' | 'endDate',
  from?: string,
  to?: string,
) {
  if (!from && !to) return;
  const cond: Prisma.StringNullableFilter = {};
  if (from) cond.gte = from;
  if (to) cond.lte = to;
  and.push({ [field]: cond } as Prisma.ExamRegistrationWhereInput);
}

function rangeNum(min?: number, max?: number) {
  const c: Prisma.FloatNullableFilter | Prisma.IntNullableFilter = {};
  if (min !== undefined) (c as any).gte = min;
  if (max !== undefined) (c as any).lte = max;
  return c;
}

// Columns allowed for sorting (allow-list — never sort by raw user input).
export const SORTABLE_COLUMNS = [
  'updatedAt', 'createdAt', 'lastSyncAt', 'dashboardStatus', 'studentExternalId',
  'examSubject', 'grade', 'syncStatus', 'testCodeNormalized',
] as const;

export function safeSort(sortBy?: string, sortDir?: string): { field: string; dir: 'asc' | 'desc' } {
  const field = SORTABLE_COLUMNS.includes((sortBy ?? '') as any) ? (sortBy as string) : 'updatedAt';
  const dir = sortDir === 'asc' ? 'asc' : 'desc';
  return { field, dir };
}

/** Serialize a filter back to a query string (URL persistence / exports). */
export function filterToQuery(f: AdvancedFilter): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) {
    if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  }
  return p.toString();
}
