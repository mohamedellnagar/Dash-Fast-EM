import { ERROR_CATEGORY, ErrorCategory } from '../../lib/enums';

// Base retry backoff (seconds): attempt 1 immediate, attempt 2 ~30s, attempt 3
// ~2min, then exponential capped. Full jitter avoids retry storms across workers.
const BASE_SECONDS = [0, 30, 120];
const CAP_MS = 15 * 60 * 1000;

export function backoffMs(attempt: number, rand: () => number = Math.random): number {
  let base: number;
  if (attempt <= BASE_SECONDS.length) base = BASE_SECONDS[attempt - 1] * 1000;
  else base = Math.min(CAP_MS, 120000 * Math.pow(2, attempt - BASE_SECONDS.length));
  if (base === 0) return 0;
  // Full jitter: random in [base/2, base].
  return Math.floor(base / 2 + rand() * (base / 2));
}

// Retry policy per error category.
export interface RetryDecision {
  action: 'RETRY' | 'DEAD_LETTER' | 'MANUAL_REVIEW';
  delayMs: number;
}

export function decideRetry(
  category: ErrorCategory,
  attemptCount: number,
  maxAttempts: number,
  opts: { retryAfterMs?: number; rand?: () => number } = {},
): RetryDecision {
  const rand = opts.rand ?? Math.random;

  // Permanent validation errors — never retry repeatedly.
  if (category === ERROR_CATEGORY.INVALID_TEST_CODE) return { action: 'DEAD_LETTER', delayMs: 0 };
  if (category === ERROR_CATEGORY.WORKSPACE_MISMATCH) return { action: 'MANUAL_REVIEW', delayMs: 0 };

  // NOT_FOUND: limited retries then manual review.
  if (category === ERROR_CATEGORY.NOT_FOUND) {
    if (attemptCount >= Math.min(maxAttempts, 2)) return { action: 'MANUAL_REVIEW', delayMs: 0 };
    return { action: 'RETRY', delayMs: backoffMs(attemptCount + 1, rand) };
  }

  if (attemptCount >= maxAttempts) {
    return { action: category === ERROR_CATEGORY.AUTHENTICATION ? 'MANUAL_REVIEW' : 'DEAD_LETTER', delayMs: 0 };
  }

  // Rate limit: respect Retry-After when available, else backoff.
  if (category === ERROR_CATEGORY.RATE_LIMIT) {
    return { action: 'RETRY', delayMs: opts.retryAfterMs ?? backoffMs(attemptCount + 1, rand) };
  }

  return { action: 'RETRY', delayMs: backoffMs(attemptCount + 1, rand) };
}
