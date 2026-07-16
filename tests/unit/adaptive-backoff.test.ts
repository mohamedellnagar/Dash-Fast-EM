import { describe, it, expect } from 'vitest';
import { nextSyncDelaySeconds, applyJitter, POLL_INTERVALS_SECONDS, MAX_POLL_INTERVALS_SECONDS } from '../../src/services/sync/policy';
import { DASHBOARD_STATUS } from '../../src/lib/enums';

describe('adaptive backoff', () => {
  it('returns the base interval when the status has not repeated', () => {
    expect(nextSyncDelaySeconds(DASHBOARD_STATUS.NOT_STARTED, false, 0)).toBe(POLL_INTERVALS_SECONDS.NOT_STARTED_BEFORE_WINDOW);
    expect(nextSyncDelaySeconds(DASHBOARD_STATUS.IN_PROGRESS, false, 0)).toBe(POLL_INTERVALS_SECONDS.IN_PROGRESS);
  });

  it('grows the interval by 1.5x per unchanged poll', () => {
    const base = POLL_INTERVALS_SECONDS.NOT_STARTED_BEFORE_WINDOW; // 600
    expect(nextSyncDelaySeconds(DASHBOARD_STATUS.NOT_STARTED, false, 1)).toBe(Math.round(base * 1.5)); // 900
    expect(nextSyncDelaySeconds(DASHBOARD_STATUS.NOT_STARTED, false, 2)).toBe(Math.round(base * 2.25)); // 1350
  });

  it('never exceeds the per-status cap', () => {
    const cap = MAX_POLL_INTERVALS_SECONDS[DASHBOARD_STATUS.NOT_STARTED]; // 1800
    expect(nextSyncDelaySeconds(DASHBOARD_STATUS.NOT_STARTED, false, 50)).toBe(cap);
    expect(nextSyncDelaySeconds(DASHBOARD_STATUS.IN_PROGRESS, false, 50)).toBe(MAX_POLL_INTERVALS_SECONDS[DASHBOARD_STATUS.IN_PROGRESS]);
  });

  it('resets to base cadence when the caller passes unchangedPolls = 0 (status changed)', () => {
    expect(nextSyncDelaySeconds(DASHBOARD_STATUS.NOT_STARTED, true, 0)).toBe(POLL_INTERVALS_SECONDS.NOT_STARTED_ACTIVE_WINDOW);
  });
});

describe('applyJitter', () => {
  it('adds 0..15% (capped at 5 min) with a deterministic rng', () => {
    expect(applyJitter(600, () => 0)).toBe(600);        // no jitter
    expect(applyJitter(600, () => 1)).toBe(690);        // +15% of 600 = 90
    expect(applyJitter(100000, () => 1)).toBe(100300);  // capped at +300s
  });
  it('stays within bounds for random rng', () => {
    for (let i = 0; i < 50; i++) {
      const d = applyJitter(1200);
      expect(d).toBeGreaterThanOrEqual(1200);
      expect(d).toBeLessThanOrEqual(1200 + 180); // 15% of 1200
    }
  });
});
