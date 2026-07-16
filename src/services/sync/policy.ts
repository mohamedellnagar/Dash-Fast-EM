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

// Adaptive-backoff ceilings (seconds) per status: how far the interval may grow
// when the status keeps coming back unchanged. Kept modest so we still catch a
// transition reasonably fast even without knowing the exam schedule.
export const MAX_POLL_INTERVALS_SECONDS: Record<string, number> = {
  [DASHBOARD_STATUS.NOT_STARTED]: 1800, // cap 30 min — stay responsive to a start
  [DASHBOARD_STATUS.IN_PROGRESS]: 3600, // cap 60 min
  [DASHBOARD_STATUS.UNDER_REVIEW]: 1800,
  [DASHBOARD_STATUS.REVIEW_FAILED]: 3600,
  [DASHBOARD_STATUS.UNKNOWN]: 3600,
};
const BACKOFF_BASE = 1.5;

function baseDelaySeconds(dashboardStatus: string, inActiveWindow: boolean): number {
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

/**
 * Compute the next poll delay for a registration given its normalized status,
 * whether the exam window is active, and how many consecutive polls have already
 * returned the SAME status (unchangedPolls). Adaptive backoff: the interval grows
 * by 1.5x per unchanged poll, capped per status. A status change resets
 * unchangedPolls to 0 (caller), snapping the cadence back to the base interval.
 */
export function nextSyncDelaySeconds(dashboardStatus: string, inActiveWindow: boolean, unchangedPolls = 0): number {
  const base = baseDelaySeconds(dashboardStatus, inActiveWindow);
  const cap = MAX_POLL_INTERVALS_SECONDS[dashboardStatus];
  if (!cap || unchangedPolls <= 0) return base;
  const grown = Math.round(base * Math.pow(BACKOFF_BASE, unchangedPolls));
  return Math.min(cap, grown);
}

/**
 * Spread a computed delay by up to +15% (max +5 min) of random jitter so that a
 * batch of registrations synced together drift apart over time instead of all
 * becoming due again at the same instant (thundering-herd de-synchronization).
 */
export function applyJitter(delaySeconds: number, rng: () => number = Math.random): number {
  const spread = Math.min(delaySeconds * 0.15, 300);
  return Math.round(delaySeconds + rng() * spread);
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
