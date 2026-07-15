import { describe, it, expect } from 'vitest';
import { toDashboardStatus, DASHBOARD_STATUS, PERMANENT_ERRORS, SYNC_ERROR } from '../../src/lib/enums';

describe('Status mapping', () => {
  it('maps all known FastTest statuses', () => {
    expect(toDashboardStatus('NEW')).toBe(DASHBOARD_STATUS.NOT_STARTED);
    expect(toDashboardStatus('INPROGRESS')).toBe(DASHBOARD_STATUS.IN_PROGRESS);
    expect(toDashboardStatus('COMPLETED')).toBe(DASHBOARD_STATUS.COMPLETED);
    expect(toDashboardStatus('INREVIEW')).toBe(DASHBOARD_STATUS.UNDER_REVIEW);
    expect(toDashboardStatus('FAILEDREVIEW')).toBe(DASHBOARD_STATUS.REVIEW_FAILED);
  });
  it('is case/format insensitive', () => {
    expect(toDashboardStatus('in progress')).toBe(DASHBOARD_STATUS.IN_PROGRESS);
    expect(toDashboardStatus('In_Review')).toBe(DASHBOARD_STATUS.UNDER_REVIEW);
  });
  it('falls back to UNKNOWN for unrecognized/empty', () => {
    expect(toDashboardStatus('SOMETHING')).toBe(DASHBOARD_STATUS.UNKNOWN);
    expect(toDashboardStatus(null)).toBe(DASHBOARD_STATUS.UNKNOWN);
    expect(toDashboardStatus('')).toBe(DASHBOARD_STATUS.UNKNOWN);
  });
  it('classifies NOT_FOUND / INVALID_TESTCODE as permanent', () => {
    expect(PERMANENT_ERRORS).toContain(SYNC_ERROR.NOT_FOUND);
    expect(PERMANENT_ERRORS).toContain(SYNC_ERROR.INVALID_TESTCODE);
    expect(PERMANENT_ERRORS).not.toContain(SYNC_ERROR.TIMEOUT);
  });
});
