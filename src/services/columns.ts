import { formatInZone } from '../lib/exam-time';
import { env } from '../config/env';
// Canonical registration table columns. Shared by the Live Monitoring table,
// saved views (column selection/order), and exports so they stay consistent.
// Each column exposes a getter that returns the RAW value (or null when the
// value is genuinely unavailable — callers render null as "—" and never
// coerce it to 0).

export interface RegRowCtx {
  canUnmaskPii: boolean;
}

export interface ColumnDef {
  key: string;
  label: string;
  defaultVisible: boolean;
  numeric?: boolean;
  get: (row: any, ctx: RegRowCtx) => string | number | boolean | null;
}

/** Mask an Emirates ID unless the caller is permitted to see PII. */
export function maskEmiratesId(value: string | null | undefined, canUnmask: boolean): string | null {
  if (!value) return null;
  if (canUnmask) return value;
  const digits = value.replace(/\D/g, '');
  if (digits.length < 4) return '***';
  return `***-****-*******-${digits.slice(-1)}`; // reveal only the last check digit
}

const firstResult = (row: any) => (row.results && row.results[0]) || null;

export const REGISTRATION_COLUMNS: ColumnDef[] = [
  { key: 'StudentId', label: 'Student ID', defaultVisible: true, get: (r) => r.studentExternalId ?? null },
  { key: 'NameArabic', label: 'Name (Arabic)', defaultVisible: true, get: (r) => r.student?.nameArabic ?? null },
  { key: 'NameEnglish', label: 'Name (English)', defaultVisible: true, get: (r) => r.student?.nameEnglish ?? null },
  { key: 'EmiratesId', label: 'Emirates ID', defaultVisible: true, get: (r, c) => maskEmiratesId(r.student?.emiratesId, c.canUnmaskPii) },
  { key: 'SchoolId', label: 'School ID', defaultVisible: false, get: (r) => r.school?.externalId ?? null },
  { key: 'SchoolName', label: 'School', defaultVisible: true, get: (r) => r.school?.name ?? null },
  { key: 'Grade', label: 'Grade', defaultVisible: true, get: (r) => r.grade ?? null },
  { key: 'ClassCode', label: 'Class', defaultVisible: true, get: (r) => r.classCode ?? null },
  { key: 'ExamSubject', label: 'Subject', defaultVisible: true, get: (r) => r.examSubject ?? null },
  { key: 'ExamName', label: 'Exam Name', defaultVisible: true, get: (r) => r.examName ?? null },
  { key: 'ProgramType', label: 'Program', defaultVisible: true, get: (r) => r.programType ?? null },
  { key: 'TestCode', label: 'Test Code', defaultVisible: true, get: (r) => r.testCodeOriginal ?? null },
  { key: 'AttendanceOriginal', label: 'Attendance', defaultVisible: false, get: (r) => r.attendanceOriginal ?? null },
  { key: 'FastTestStatus', label: 'Status', defaultVisible: true, get: (r) => r.dashboardStatus ?? null },
  { key: 'RegistrationDate', label: 'Registration Date', defaultVisible: false, get: (r) => r.fastTestRegistrationDate ?? null },
  // Exam start is shown on the local clock. FastTest records it on a US clock
  // and sends it with no timezone, so the raw string would read hours off; the
  // converted instant is used, with the vendor original kept as a separate
  // opt-in column for troubleshooting.
  { key: 'ActualStartTime', label: `Actual Start (${env.displayTimezone})`, defaultVisible: true,
    get: (r) => formatInZone(r.actualStartTimeUtc, env.displayTimezone) ?? null },
  { key: 'ActualStartTimeRaw', label: 'Actual Start (FastTest raw)', defaultVisible: false,
    get: (r) => r.actualStartTime ?? null },
  { key: 'TimeUsed', label: 'Time Used (s)', defaultVisible: true, numeric: true, get: (r) => r.secondsUsed ?? null },
  { key: 'RawScore', label: 'Raw Score', defaultVisible: true, numeric: true, get: (r) => firstResult(r)?.rawScore ?? null },
  { key: 'ScaledScore', label: 'Scaled Score', defaultVisible: false, numeric: true, get: (r) => firstResult(r)?.scaledScore ?? null },
  { key: 'Correct', label: 'Correct', defaultVisible: false, numeric: true, get: (r) => firstResult(r)?.correctCount ?? null },
  { key: 'Incorrect', label: 'Incorrect', defaultVisible: false, numeric: true, get: (r) => firstResult(r)?.incorrectCount ?? null },
  { key: 'Skipped', label: 'Skipped', defaultVisible: false, numeric: true, get: (r) => firstResult(r)?.skippedCount ?? null },
  { key: 'Attempted', label: 'Attempted', defaultVisible: false, numeric: true, get: (r) => firstResult(r)?.attemptedItems ?? null },
  { key: 'TotalItems', label: 'Total Items', defaultVisible: false, numeric: true, get: (r) => firstResult(r)?.totalItemsCount ?? null },
  { key: 'CompletionPercentage', label: 'Completion %', defaultVisible: false, numeric: true, get: (r) => firstResult(r)?.completionPercentage ?? null },
  { key: 'SyncStatus', label: 'Sync', defaultVisible: true, get: (r) => r.syncStatus ?? null },
  { key: 'LastSyncAt', label: 'Last Sync', defaultVisible: true, get: (r) => (r.lastSyncAt ? new Date(r.lastSyncAt).toISOString() : null) },
  { key: 'ApiError', label: 'API Error', defaultVisible: false, get: (r) => r.syncError ?? null },
];

export const COLUMN_KEYS = REGISTRATION_COLUMNS.map((c) => c.key);
export const DEFAULT_COLUMNS = REGISTRATION_COLUMNS.filter((c) => c.defaultVisible).map((c) => c.key);
const BY_KEY = new Map(REGISTRATION_COLUMNS.map((c) => [c.key, c]));

/** Resolve an ordered, validated list of visible columns. */
export function resolveColumns(requested?: string[]): ColumnDef[] {
  if (!requested || !requested.length) return REGISTRATION_COLUMNS.filter((c) => c.defaultVisible);
  const cols = requested.map((k) => BY_KEY.get(k)).filter((c): c is ColumnDef => !!c);
  return cols.length ? cols : REGISTRATION_COLUMNS.filter((c) => c.defaultVisible);
}

/** Render a raw value for display: null → "—". */
export function display(v: string | number | boolean | null): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  return String(v);
}
