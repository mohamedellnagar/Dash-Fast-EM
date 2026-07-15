import * as XLSX from 'xlsx';
import { prisma } from '../db/prisma';
import { AdvancedFilter, buildRegistrationWhere, safeSort } from './filters';
import { REGISTRATION_COLUMNS, resolveColumns, ColumnDef, maskEmiratesId } from './columns';
import { schoolsSummary, subjectsSummary } from './dashboard.service';
import { listAttention } from './attention.service';
import { SYNC_STATUS, DASHBOARD_STATUS } from '../lib/enums';

export const EXPORT_PRESETS = {
  ALL: 'All Records',
  CURRENT_FILTER: 'Current Filtered View',
  NOT_STARTED: 'Not Started',
  IN_PROGRESS: 'In Progress',
  COMPLETED: 'Completed',
  UNDER_REVIEW: 'Under Review',
  REVIEW_FAILED: 'Review Failed',
  UNKNOWN: 'Unknown',
  API_ERRORS: 'API Errors',
  SYNC_FAILURES: 'Sync Failures',
  SCHOOL_SUMMARY: 'School Summary',
  SUBJECT_SUMMARY: 'Subject Summary',
  RESULTS_SUMMARY: 'Results Summary',
  ATTENTION: 'Students Requiring Attention',
} as const;
export type ExportPreset = keyof typeof EXPORT_PRESETS;

const STATUS_PRESETS: Record<string, string> = {
  NOT_STARTED: DASHBOARD_STATUS.NOT_STARTED,
  IN_PROGRESS: DASHBOARD_STATUS.IN_PROGRESS,
  COMPLETED: DASHBOARD_STATUS.COMPLETED,
  UNDER_REVIEW: DASHBOARD_STATUS.UNDER_REVIEW,
  REVIEW_FAILED: DASHBOARD_STATUS.REVIEW_FAILED,
  UNKNOWN: DASHBOARD_STATUS.UNKNOWN,
};

const MAX_ROWS = 5000;

/** Prevent CSV/Excel formula injection: neutralize risky leading characters. */
export function sanitizeCell(v: string | number | boolean | null): string | number | boolean | null {
  if (typeof v !== 'string') return v;
  if (/^[=+\-@\t\r]/.test(v)) return `'${v}`;
  return v;
}

/** Apply a preset on top of the user's current filter. */
export function applyPreset(preset: ExportPreset, base: AdvancedFilter): AdvancedFilter {
  if (preset === 'ALL') return {};
  if (preset === 'CURRENT_FILTER') return base;
  if (STATUS_PRESETS[preset]) return { ...base, status: STATUS_PRESETS[preset] };
  if (preset === 'API_ERRORS' || preset === 'SYNC_FAILURES') return { ...base, apiError: '1' };
  return base;
}

export interface ExportContext {
  userId?: string;
  actorEmail?: string;
  canUnmaskPii: boolean;
  scopeSchoolIds?: string[];
}

export interface ExportOutput {
  buffer: Buffer;
  contentType: string;
  filename: string;
  count: number;
}

function toWorkbook(rows: Record<string, any>[], sheetName: string, format: 'csv' | 'xlsx'): { buffer: Buffer; contentType: string; ext: string } {
  const sanitized = rows.map((r) => {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(r)) out[k] = sanitizeCell(v ?? '');
    return out;
  });
  const ws = XLSX.utils.json_to_sheet(sanitized);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  if (format === 'xlsx') {
    return { buffer: XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }), contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: 'xlsx' };
  }
  const csv = '﻿' + XLSX.utils.sheet_to_csv(ws); // BOM for Excel/Arabic
  return { buffer: Buffer.from(csv, 'utf8'), contentType: 'text/csv; charset=utf-8', ext: 'csv' };
}

function rowFromColumns(reg: any, cols: ColumnDef[], canUnmaskPii: boolean): Record<string, any> {
  const out: Record<string, any> = {};
  for (const c of cols) {
    const v = c.get(reg, { canUnmaskPii });
    out[c.label] = v ?? ''; // null → empty for spreadsheets
  }
  return out;
}

/**
 * Run an export. Records an ExportJob for history, enforces school scope, and
 * respects the selected columns/sort. Never includes secrets. Raw API JSON is
 * excluded (admin-only, separate explicit endpoint).
 */
export async function runExport(
  preset: ExportPreset,
  format: 'csv' | 'xlsx',
  baseFilter: AdvancedFilter,
  columns: string[] | undefined,
  sortBy: string | undefined,
  sortDir: string | undefined,
  ctx: ExportContext,
): Promise<ExportOutput> {
  const job = await prisma.exportJob.create({
    data: {
      userId: ctx.userId ?? null, exportType: preset, format,
      filtersJson: JSON.stringify(baseFilter), status: 'PENDING', createdBy: ctx.actorEmail ?? null,
    },
  });

  try {
    let rows: Record<string, any>[];
    let sheet = 'Export';

    if (preset === 'SCHOOL_SUMMARY') {
      const where = buildRegistrationWhere(baseFilter, ctx.scopeSchoolIds);
      const data = await schoolsSummary(where);
      sheet = 'Schools';
      rows = data.map((s) => ({
        'School ID': s.externalId ?? '', School: s.schoolName, Total: s.total,
        'Not Started': s.NOT_STARTED, 'In Progress': s.IN_PROGRESS, Completed: s.COMPLETED,
        'Under Review': s.UNDER_REVIEW, 'Review Failed': s.REVIEW_FAILED, Unknown: s.UNKNOWN,
        'Completion %': s.completionRate, 'Avg Time (s)': s.avgTimeUsed ?? '', 'Avg Raw Score': s.avgRawScore ?? '', 'API Errors': s.apiErrors,
      }));
    } else if (preset === 'SUBJECT_SUMMARY') {
      const where = buildRegistrationWhere(baseFilter, ctx.scopeSchoolIds);
      const data = await subjectsSummary(where);
      sheet = 'Subjects';
      rows = data.map((s) => ({
        Subject: s.examSubject, Total: s.total, 'Not Started': s.NOT_STARTED, 'In Progress': s.IN_PROGRESS,
        Completed: s.COMPLETED, 'Completion %': s.completionRate, 'Avg Duration (s)': s.avgTimeUsed ?? '',
        'Avg Raw Score': s.avgRawScore ?? '', 'Avg Scaled Score': s.avgScaledScore ?? '',
        Correct: s.correct, Incorrect: s.incorrect, Skipped: s.skipped,
      }));
    } else if (preset === 'ATTENTION') {
      const data = await listAttention({ status: 'OPEN' }, ctx.scopeSchoolIds, 1, MAX_ROWS);
      sheet = 'Attention';
      rows = data.rows.map((a: any) => ({
        Student: a.registration?.studentExternalId ?? '', School: a.registration?.school?.name ?? '',
        Subject: a.registration?.examSubject ?? '', TestCode: a.registration?.testCodeOriginal ?? '',
        Issue: a.issueType, Severity: a.severity, Status: a.status, 'Last Error': a.lastError ?? '',
        'Retry Count': a.retryCount, 'Recommended Action': a.recommendedAction,
      }));
    } else {
      // Registration-based presets (incl. RESULTS_SUMMARY which uses columns).
      const filter = applyPreset(preset, baseFilter);
      const where = buildRegistrationWhere(filter, ctx.scopeSchoolIds);
      const { field, dir } = safeSort(sortBy, sortDir);
      const cols = preset === 'RESULTS_SUMMARY'
        ? REGISTRATION_COLUMNS.filter((c) => ['StudentId', 'SchoolName', 'ExamSubject', 'TestCode', 'FastTestStatus', 'RawScore', 'ScaledScore', 'Correct', 'Incorrect', 'Skipped', 'Attempted', 'TotalItems', 'CompletionPercentage', 'TimeUsed'].includes(c.key))
        : resolveColumns(columns);
      const regs = await prisma.examRegistration.findMany({
        where, orderBy: { [field]: dir }, take: MAX_ROWS,
        include: { student: true, school: true, subject: true, results: { orderBy: { createdAt: 'desc' }, take: 1 } },
      });
      sheet = 'Registrations';
      rows = regs.map((r) => rowFromColumns(r, cols, ctx.canUnmaskPii));
    }

    const { buffer, contentType, ext } = toWorkbook(rows, sheet, format);
    await prisma.exportJob.update({ where: { id: job.id }, data: { status: 'COMPLETED', recordCount: rows.length, completedAt: new Date() } });
    return { buffer, contentType, filename: `${preset.toLowerCase()}-${job.id.slice(0, 8)}.${ext}`, count: rows.length };
  } catch (e) {
    await prisma.exportJob.update({ where: { id: job.id }, data: { status: 'FAILED', failureReason: (e as Error).message.slice(0, 500), completedAt: new Date() } });
    throw e;
  }
}

export async function listExportHistory(userId?: string, isAdmin = false, limit = 50) {
  return prisma.exportJob.findMany({
    where: isAdmin ? {} : { userId: userId ?? '__none__' },
    orderBy: { startedAt: 'desc' },
    take: limit,
  });
}
