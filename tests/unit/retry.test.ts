import { describe, it, expect } from 'vitest';
import { backoffMs, decideRetry } from '../../src/services/sync/retry';
import { ERROR_CATEGORY } from '../../src/lib/enums';

describe('Retry backoff', () => {
  it('first attempt is immediate', () => {
    expect(backoffMs(1)).toBe(0);
  });
  it('grows and stays within full-jitter bounds', () => {
    const rand = () => 0.5;
    expect(backoffMs(2, rand)).toBe(Math.floor(30000 / 2 + 0.5 * 15000)); // 22500
    expect(backoffMs(3, rand)).toBe(Math.floor(120000 / 2 + 0.5 * 60000)); // 90000
    // jitter keeps values within [base/2, base]
    const b = backoffMs(2, () => 0);
    expect(b).toBeGreaterThanOrEqual(15000);
    expect(backoffMs(2, () => 0.999)).toBeLessThanOrEqual(30000);
  });
  it('caps exponential growth', () => {
    expect(backoffMs(20, () => 1)).toBeLessThanOrEqual(15 * 60 * 1000);
  });
});

describe('Retry decisions by error category', () => {
  it('never retries invalid test code', () => {
    expect(decideRetry(ERROR_CATEGORY.INVALID_TEST_CODE, 1, 3).action).toBe('DEAD_LETTER');
  });
  it('workspace mismatch → manual review', () => {
    expect(decideRetry(ERROR_CATEGORY.WORKSPACE_MISMATCH, 1, 3).action).toBe('MANUAL_REVIEW');
  });
  it('not found → limited retry then manual review', () => {
    expect(decideRetry(ERROR_CATEGORY.NOT_FOUND, 1, 3).action).toBe('RETRY');
    expect(decideRetry(ERROR_CATEGORY.NOT_FOUND, 2, 3).action).toBe('MANUAL_REVIEW');
  });
  it('rate limit respects Retry-After', () => {
    const d = decideRetry(ERROR_CATEGORY.RATE_LIMIT, 1, 5, { retryAfterMs: 5000 });
    expect(d.action).toBe('RETRY');
    expect(d.delayMs).toBe(5000);
  });
  it('timeouts retry with backoff until max attempts, then dead-letter', () => {
    expect(decideRetry(ERROR_CATEGORY.TIMEOUT, 1, 3).action).toBe('RETRY');
    expect(decideRetry(ERROR_CATEGORY.TIMEOUT, 3, 3).action).toBe('DEAD_LETTER');
  });
  it('authentication exhaustion → manual review', () => {
    expect(decideRetry(ERROR_CATEGORY.AUTHENTICATION, 3, 3).action).toBe('MANUAL_REVIEW');
  });
});
