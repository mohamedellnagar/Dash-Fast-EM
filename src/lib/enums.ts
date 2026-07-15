// Application-level enums. Because the schema is provider-agnostic (SQLite dev
// / Postgres prod) we validate these in code rather than with native DB enums.

export const ROLE = {
  ADMINISTRATOR: 'ADMINISTRATOR',
  OPERATIONS: 'OPERATIONS',
  ASSESSMENT_TEAM: 'ASSESSMENT_TEAM',
  SCHOOL_USER: 'SCHOOL_USER',
  VIEWER: 'VIEWER',
} as const;
export type RoleKey = (typeof ROLE)[keyof typeof ROLE];

export const PERMISSION = {
  DASHBOARD_VIEW: 'dashboard:view',
  MONITORING_VIEW: 'monitoring:view',
  STUDENT_VIEW: 'student:view',
  RESULTS_VIEW: 'results:view',
  RAW_RESPONSE_VIEW: 'raw:view',
  IMPORT_RUN: 'import:run',
  EXPORT_RUN: 'export:run',
  MANUAL_SYNC: 'sync:manual',
  INTEGRATION_MANAGE: 'integration:manage',
  API_MONITORING_VIEW: 'apimonitoring:view',
  AUDIT_VIEW: 'audit:view',
  USER_MANAGE: 'user:manage',
  LOADTEST_RUN: 'loadtest:run',
  // Phase 2
  ATTENTION_VIEW: 'attention:view',
  ATTENTION_MANAGE: 'attention:manage',
  SAVED_VIEW_SHARE: 'savedview:share', // create views shared with all users
  PII_UNMASK: 'pii:unmask', // view unmasked Emirates ID
  // Phase 3 — sync platform operations
  SYNC_VIEW: 'sync:view',
  SYNC_BULK: 'sync:bulk',
  SYNC_CANCEL: 'sync:cancel',
  SYNC_RETRY: 'sync:retry',
  SYNC_ADMIN: 'sync:admin',
  QUEUE_VIEW: 'queue:view',
  QUEUE_MANAGE: 'queue:manage',
  WORKER_VIEW: 'worker:view',
  WORKSPACE_PAUSE: 'workspace:pause',
  ALERT_VIEW: 'alert:view',
  ALERT_MANAGE: 'alert:manage',
} as const;
export type PermissionKey = (typeof PERMISSION)[keyof typeof PERMISSION];

// Raw FastTest statuses
export const FASTTEST_STATUS = {
  NEW: 'NEW',
  INPROGRESS: 'INPROGRESS',
  COMPLETED: 'COMPLETED',
  INREVIEW: 'INREVIEW',
  FAILEDREVIEW: 'FAILEDREVIEW',
} as const;

// Normalized dashboard statuses
export const DASHBOARD_STATUS = {
  NOT_SYNCED: 'NOT_SYNCED', // never synced with FastTest yet (pre-sync default)
  NOT_STARTED: 'NOT_STARTED',
  IN_PROGRESS: 'IN_PROGRESS',
  COMPLETED: 'COMPLETED',
  UNDER_REVIEW: 'UNDER_REVIEW',
  REVIEW_FAILED: 'REVIEW_FAILED',
  UNKNOWN: 'UNKNOWN',
} as const;
export type DashboardStatus = (typeof DASHBOARD_STATUS)[keyof typeof DASHBOARD_STATUS];

const STATUS_MAP: Record<string, DashboardStatus> = {
  NEW: DASHBOARD_STATUS.NOT_STARTED,
  INPROGRESS: DASHBOARD_STATUS.IN_PROGRESS,
  IN_PROGRESS: DASHBOARD_STATUS.IN_PROGRESS,
  COMPLETED: DASHBOARD_STATUS.COMPLETED,
  INREVIEW: DASHBOARD_STATUS.UNDER_REVIEW,
  FAILEDREVIEW: DASHBOARD_STATUS.REVIEW_FAILED,
};

/** Map a raw FastTest status to the normalized dashboard status. */
export function toDashboardStatus(raw: string | null | undefined): DashboardStatus {
  if (!raw) return DASHBOARD_STATUS.UNKNOWN;
  const key = raw.trim().toUpperCase().replace(/[\s_-]/g, '');
  return STATUS_MAP[key] ?? STATUS_MAP[raw.trim().toUpperCase()] ?? DASHBOARD_STATUS.UNKNOWN;
}

export const SYNC_STATUS = {
  PENDING: 'PENDING',
  OK: 'OK',
  ERROR: 'ERROR',
  MANUAL_REVIEW: 'MANUAL_REVIEW',
} as const;

export const JOB_STATUS = {
  QUEUED: 'QUEUED',
  RUNNING: 'RUNNING',
  DONE: 'DONE',
  FAILED: 'FAILED',
  RETRY_SCHEDULED: 'RETRY_SCHEDULED',
  DEAD_LETTER: 'DEAD_LETTER',
  CANCELLED: 'CANCELLED',
  MANUAL_REVIEW: 'MANUAL_REVIEW',
} as const;
export type JobStatus = (typeof JOB_STATUS)[keyof typeof JOB_STATUS];

// Terminal statuses never get re-processed.
export const TERMINAL_JOB_STATUSES = [JOB_STATUS.DONE, JOB_STATUS.DEAD_LETTER, JOB_STATUS.CANCELLED, JOB_STATUS.MANUAL_REVIEW];

export const JOB_TYPE = {
  AUTHENTICATE_WORKSPACE: 'AUTHENTICATE_WORKSPACE',
  SYNC_REGISTRATION_STATUS: 'SYNC_REGISTRATION_STATUS',
  SYNC_REGISTRATION_RESULTS: 'SYNC_REGISTRATION_RESULTS',
  SYNC_REGISTRATION_FULL: 'SYNC_REGISTRATION_FULL',
  SYNC_WORKSPACE_BATCH: 'SYNC_WORKSPACE_BATCH',
  SYNC_SCHOOL_BATCH: 'SYNC_SCHOOL_BATCH',
  SYNC_SUBJECT_BATCH: 'SYNC_SUBJECT_BATCH',
  SYNC_ACTIVE_EXAMS: 'SYNC_ACTIVE_EXAMS',
  REFRESH_ATTENTION_ITEMS: 'REFRESH_ATTENTION_ITEMS',
  REFRESH_ANALYTICS_CACHE: 'REFRESH_ANALYTICS_CACHE',
  RETRY_FAILED_SYNC: 'RETRY_FAILED_SYNC',
  MANUAL_SYNC: 'MANUAL_SYNC',
} as const;
export type JobType = (typeof JOB_TYPE)[keyof typeof JOB_TYPE];

// Default priority per job type (lower = higher priority).
export const JOB_PRIORITY: Record<string, number> = {
  MANUAL_SYNC: 10,
  AUTHENTICATE_WORKSPACE: 20,
  SYNC_ACTIVE_EXAMS: 30,
  SYNC_REGISTRATION_RESULTS: 40,
  SYNC_REGISTRATION_STATUS: 50,
  SYNC_REGISTRATION_FULL: 45,
  RETRY_FAILED_SYNC: 60,
  SYNC_WORKSPACE_BATCH: 70,
  SYNC_SCHOOL_BATCH: 70,
  SYNC_SUBJECT_BATCH: 70,
  REFRESH_ATTENTION_ITEMS: 80,
  REFRESH_ANALYTICS_CACHE: 90,
};

// Formal registration sync-state machine (see src/lib/sync-state.ts).
export const SYNC_STATE = {
  PENDING: 'PENDING',
  QUEUED: 'QUEUED',
  SYNCING_STATUS: 'SYNCING_STATUS',
  STATUS_SYNCED: 'STATUS_SYNCED',
  SYNCING_RESULTS: 'SYNCING_RESULTS',
  RESULTS_SYNCED: 'RESULTS_SYNCED',
  COMPLETED: 'COMPLETED',
  NOT_FOUND: 'NOT_FOUND',
  AUTH_FAILED: 'AUTH_FAILED',
  API_ERROR: 'API_ERROR',
  TIMEOUT: 'TIMEOUT',
  RATE_LIMITED: 'RATE_LIMITED',
  RETRY_SCHEDULED: 'RETRY_SCHEDULED',
  MANUAL_REVIEW: 'MANUAL_REVIEW',
  STALE: 'STALE',
} as const;
export type SyncState = (typeof SYNC_STATE)[keyof typeof SYNC_STATE];

// Standardized error categories for FastTest + network + infra errors.
export const ERROR_CATEGORY = {
  AUTHENTICATION: 'AUTHENTICATION',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  NOT_FOUND: 'NOT_FOUND',
  INVALID_TEST_CODE: 'INVALID_TEST_CODE',
  WORKSPACE_MISMATCH: 'WORKSPACE_MISMATCH',
  RATE_LIMIT: 'RATE_LIMIT',
  TIMEOUT: 'TIMEOUT',
  NETWORK: 'NETWORK',
  FASTTEST_INTERNAL_ERROR: 'FASTTEST_INTERNAL_ERROR',
  INVALID_RESPONSE: 'INVALID_RESPONSE',
  DATABASE: 'DATABASE',
  QUEUE: 'QUEUE',
  UNKNOWN: 'UNKNOWN',
} as const;
export type ErrorCategory = (typeof ERROR_CATEGORY)[keyof typeof ERROR_CATEGORY];

export const CIRCUIT_STATE = { CLOSED: 'CLOSED', OPEN: 'OPEN', HALF_OPEN: 'HALF_OPEN' } as const;
export const WORKER_STATUS = { HEALTHY: 'HEALTHY', DEGRADED: 'DEGRADED', STALE: 'STALE', OFFLINE: 'OFFLINE' } as const;

export const ALERT_TYPE = {
  WORKSPACE_AUTH_FAILURE: 'WORKSPACE_AUTH_FAILURE',
  CIRCUIT_OPENED: 'CIRCUIT_OPENED',
  HIGH_API_ERROR_RATE: 'HIGH_API_ERROR_RATE',
  HIGH_LATENCY: 'HIGH_LATENCY',
  QUEUE_BACKLOG: 'QUEUE_BACKLOG',
  STALE_WORKER: 'STALE_WORKER',
  DEAD_LETTER_JOBS: 'DEAD_LETTER_JOBS',
  REPEATED_500: 'REPEATED_500',
  HIGH_STALE_COUNT: 'HIGH_STALE_COUNT',
  SYNC_STOPPED: 'SYNC_STOPPED',
} as const;
export type AlertType = (typeof ALERT_TYPE)[keyof typeof ALERT_TYPE];

// Error taxonomy for sync failures — drives retry vs. give-up decisions.
export const SYNC_ERROR = {
  UNAUTHORIZED: 'UNAUTHORIZED',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  AUTH_FAILED: 'AUTH_FAILED',
  NOT_FOUND: 'NOT_FOUND',
  SERVER_ERROR: 'SERVER_ERROR',
  TIMEOUT: 'TIMEOUT',
  INVALID_TESTCODE: 'INVALID_TESTCODE',
  WORKSPACE_MISMATCH: 'WORKSPACE_MISMATCH',
  RATE_LIMITED: 'RATE_LIMITED',
  CONNECTION_FAILURE: 'CONNECTION_FAILURE',
  INVALID_RESPONSE: 'INVALID_RESPONSE',
} as const;
export type SyncErrorType = (typeof SYNC_ERROR)[keyof typeof SYNC_ERROR];

// Permanent errors are never retried indefinitely.
export const PERMANENT_ERRORS: SyncErrorType[] = [
  SYNC_ERROR.NOT_FOUND,
  SYNC_ERROR.INVALID_TESTCODE,
  SYNC_ERROR.WORKSPACE_MISMATCH,
];

// ---------------------------------------------------------------------------
// Phase 2 — Students-Requiring-Attention taxonomy
// ---------------------------------------------------------------------------
export const ATTENTION_ISSUE = {
  API_NOT_FOUND: 'API_NOT_FOUND',
  INVALID_TESTCODE: 'INVALID_TESTCODE',
  WORKSPACE_MAPPING_MISSING: 'WORKSPACE_MAPPING_MISSING',
  AUTH_FAILED: 'AUTH_FAILED',
  REPEATED_API_ERROR: 'REPEATED_API_ERROR',
  STALE_STATUS: 'STALE_STATUS',
  NO_RESULTS_AFTER_COMPLETION: 'NO_RESULTS_AFTER_COMPLETION',
  STATUS_CONFLICT: 'STATUS_CONFLICT',
  MISSING_STUDENT_MAPPING: 'MISSING_STUDENT_MAPPING',
  SYNC_FAILED_MAX_RETRIES: 'SYNC_FAILED_MAX_RETRIES',
} as const;
export type AttentionIssue = (typeof ATTENTION_ISSUE)[keyof typeof ATTENTION_ISSUE];

export const SEVERITY = { HIGH: 'HIGH', MEDIUM: 'MEDIUM', LOW: 'LOW' } as const;
export type Severity = (typeof SEVERITY)[keyof typeof SEVERITY];

export const ATTENTION_STATUS = {
  OPEN: 'OPEN',
  ACKNOWLEDGED: 'ACKNOWLEDGED',
  RESOLVED: 'RESOLVED',
} as const;

// Per-issue severity + recommended action (shown in the attention queue).
export const ATTENTION_META: Record<AttentionIssue, { severity: Severity; action: string }> = {
  API_NOT_FOUND: { severity: SEVERITY.HIGH, action: 'Verify the TestCode exists in the mapped workspace; confirm subject→workspace mapping.' },
  INVALID_TESTCODE: { severity: SEVERITY.HIGH, action: 'Correct the source TestCode and re-import; it fails normalization.' },
  WORKSPACE_MAPPING_MISSING: { severity: SEVERITY.HIGH, action: 'Add a subject alias mapping in Integration Settings for this ExamSubject.' },
  AUTH_FAILED: { severity: SEVERITY.HIGH, action: 'Check the workspace REST API key/credentials and run a connection test.' },
  REPEATED_API_ERROR: { severity: SEVERITY.MEDIUM, action: 'Inspect API Monitoring for the workspace; retry after transient errors clear.' },
  STALE_STATUS: { severity: SEVERITY.MEDIUM, action: 'Registration has not synced recently; trigger a manual sync or check the worker.' },
  NO_RESULTS_AFTER_COMPLETION: { severity: SEVERITY.MEDIUM, action: 'Status is COMPLETED but no results returned; re-run results fetch / manual sync.' },
  STATUS_CONFLICT: { severity: SEVERITY.MEDIUM, action: 'Source attendance conflicts with FastTest status; verify with the school/proctor.' },
  MISSING_STUDENT_MAPPING: { severity: SEVERITY.LOW, action: 'Registration is not linked to a student record; re-import with a valid StudentId.' },
  SYNC_FAILED_MAX_RETRIES: { severity: SEVERITY.HIGH, action: 'Automatic retries exhausted; investigate and resolve, then manual sync.' },
};
