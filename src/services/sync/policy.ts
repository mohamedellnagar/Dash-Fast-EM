import { DASHBOARD_STATUS, PERMANENT_ERRORS, SYNC_ERROR, SyncErrorType } from '../../lib/enums';

// Polling cadence (seconds) by dashboard status. Configurable via systemSettings
// override in future; defaults follow the required policy.
export const POLL_INTERVALS_SECONDS = {
  NOT_STARTED_BEFORE_WINDOW: 600, // every 10 min
  NOT_STARTED_ACTIVE_WINDOW: 120, // every 2 min during exam window
  IN_PROGRESS: 1800, // every 30 minutes
  COMPLETED: 86400, // fetch results once; then terminal (never re-synced — see scheduler)
  UNDER_REVIEW: 300, // 5 min
  REVIEW_FAILED: 900, // 15 min
  UNKNOWN: 600,
} as const;

/**
 * Compute the next poll time for a registration given its normalized status
 * and whether the exam window is currently active.
 */
export function nextSyncDelaySeconds(dashboardStatus: string, inActiveWindow: boolean): number {
  switch (dashboardStatus) {
    case DASHBOARD_STATUS.NOT_STARTED:
      return inActiveWindow
        ? POLL_INTERVALS_SECONDS.NOT_STARTED_ACTIVE_WINDOW
        : POLL_INTERVALS_SECONDS.NOT_STARTED_BEFORE_WINDOW;
    case DASHBOARD_STATUS.IN_PROGRESS:
      return POLL_INTERVALS_SECONDS.IN_PROGRESS;
    case DASHBOARD_STATUS.COMPLETED:
      return POLL_INTERVALS_SECONDS.COMPLETED;
    case DASHBOARD_STATUS.UNDER_REVIEW:
      return POLL_INTERVALS_SECONDS.UNDER_REVIEW;
    case DASHBOARD_STATUS.REVIEW_FAILED:
      return POLL_INTERVALS_SECONDS.REVIEW_FAILED;
    default:
      return POLL_INTERVALS_SECONDS.UNKNOWN;
  }
}

// Retry backoff schedule (seconds): attempt 1 immediate, then 30s, then 120s.
export const RETRY_BACKOFF_SECONDS = [0, 30, 120];

export function retryDelaySeconds(attemptNumber: number): number {
  const idx = Math.min(attemptNumber, RETRY_BACKOFF_SECONDS.length - 1);
  return RETRY_BACKOFF_SECONDS[idx];
}

export function isPermanentError(errorType: SyncErrorType): boolean {
  return PERMANENT_ERRORS.includes(errorType);
}

/** Whether a status should trigger a one-time results fetch. */
export function shouldFetchResults(dashboardStatus: string): boolean {
  return (
    dashboardStatus === DASHBOARD_STATUS.COMPLETED ||
    dashboardStatus === DASHBOARD_STATUS.UNDER_REVIEW ||
    dashboardStatus === DASHBOARD_STATUS.REVIEW_FAILED
  );
}

export { SYNC_ERROR };
