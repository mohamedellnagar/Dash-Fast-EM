import { describe, it, expect } from 'vitest';
import { classify, categoryFromHttp, categoryFromSyncError, isRetryable } from '../../src/services/sync/error-classifier';
import { ERROR_CATEGORY, SYNC_ERROR } from '../../src/lib/enums';

describe('Error classification', () => {
  it('maps HTTP statuses to categories', () => {
    expect(categoryFromHttp(401)).toBe(ERROR_CATEGORY.AUTHENTICATION);
    expect(categoryFromHttp(404)).toBe(ERROR_CATEGORY.NOT_FOUND);
    expect(categoryFromHttp(429)).toBe(ERROR_CATEGORY.RATE_LIMIT);
    expect(categoryFromHttp(500)).toBe(ERROR_CATEGORY.FASTTEST_INTERNAL_ERROR);
    expect(categoryFromHttp(0)).toBe(ERROR_CATEGORY.NETWORK);
  });
  it('maps client SyncErrorType to categories', () => {
    expect(categoryFromSyncError(SYNC_ERROR.NOT_FOUND)).toBe(ERROR_CATEGORY.NOT_FOUND);
    expect(categoryFromSyncError(SYNC_ERROR.TIMEOUT)).toBe(ERROR_CATEGORY.TIMEOUT);
    expect(categoryFromSyncError(SYNC_ERROR.INVALID_TESTCODE)).toBe(ERROR_CATEGORY.INVALID_TEST_CODE);
  });
  it('classify returns retryability + severity + action', () => {
    const c = classify({ errorType: SYNC_ERROR.RATE_LIMITED, httpStatus: 429 });
    expect(c.category).toBe(ERROR_CATEGORY.RATE_LIMIT);
    expect(c.retryable).toBe(true);
    expect(c.recommendedAction).toMatch(/Retry-After/i);
  });
  it('permanent errors are not retryable', () => {
    expect(isRetryable(ERROR_CATEGORY.INVALID_TEST_CODE)).toBe(false);
    expect(isRetryable(ERROR_CATEGORY.WORKSPACE_MISMATCH)).toBe(false);
    expect(isRetryable(ERROR_CATEGORY.TIMEOUT)).toBe(true);
  });
});
