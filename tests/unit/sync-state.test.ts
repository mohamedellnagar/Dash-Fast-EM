import { describe, it, expect } from 'vitest';
import { canTransition } from '../../src/lib/sync-state';
import { SYNC_STATE } from '../../src/lib/enums';

describe('Sync-state machine', () => {
  it('allows the happy path', () => {
    expect(canTransition(SYNC_STATE.PENDING, SYNC_STATE.QUEUED)).toBe(true);
    expect(canTransition(SYNC_STATE.QUEUED, SYNC_STATE.SYNCING_STATUS)).toBe(true);
    expect(canTransition(SYNC_STATE.SYNCING_STATUS, SYNC_STATE.STATUS_SYNCED)).toBe(true);
    expect(canTransition(SYNC_STATE.STATUS_SYNCED, SYNC_STATE.SYNCING_RESULTS)).toBe(true);
    expect(canTransition(SYNC_STATE.SYNCING_RESULTS, SYNC_STATE.RESULTS_SYNCED)).toBe(true);
    expect(canTransition(SYNC_STATE.RESULTS_SYNCED, SYNC_STATE.COMPLETED)).toBe(true);
  });
  it('rejects invalid jumps', () => {
    expect(canTransition(SYNC_STATE.PENDING, SYNC_STATE.COMPLETED)).toBe(false);
    expect(canTransition(SYNC_STATE.COMPLETED, SYNC_STATE.RESULTS_SYNCED)).toBe(false); // can't reach a synced state without syncing
    expect(canTransition(SYNC_STATE.STATUS_SYNCED, SYNC_STATE.AUTH_FAILED)).toBe(false);
    expect(canTransition(SYNC_STATE.MANUAL_REVIEW, SYNC_STATE.SYNCING_STATUS)).toBe(false); // manual review never auto-syncs
  });
  it('lets a worker begin a sync directly from any rest state (no QUEUED bridge)', () => {
    // Handlers skip the transient QUEUED transition, so every rest state must
    // allow → SYNCING_* directly.
    for (const rest of [SYNC_STATE.PENDING, SYNC_STATE.COMPLETED, SYNC_STATE.STATUS_SYNCED,
      SYNC_STATE.RESULTS_SYNCED, SYNC_STATE.API_ERROR, SYNC_STATE.NOT_FOUND, SYNC_STATE.STALE,
      SYNC_STATE.RETRY_SCHEDULED, SYNC_STATE.RATE_LIMITED, SYNC_STATE.QUEUED]) {
      expect(canTransition(rest, SYNC_STATE.SYNCING_STATUS)).toBe(true);
      expect(canTransition(rest, SYNC_STATE.SYNCING_RESULTS)).toBe(true);
    }
    // ...but MANUAL_REVIEW is deliberately excluded.
    expect(canTransition(SYNC_STATE.MANUAL_REVIEW, SYNC_STATE.SYNCING_STATUS)).toBe(false);
  });
  it('allows error and retry transitions', () => {
    expect(canTransition(SYNC_STATE.SYNCING_STATUS, SYNC_STATE.NOT_FOUND)).toBe(true);
    expect(canTransition(SYNC_STATE.RETRY_SCHEDULED, SYNC_STATE.SYNCING_STATUS)).toBe(true);
    expect(canTransition(SYNC_STATE.MANUAL_REVIEW, SYNC_STATE.QUEUED)).toBe(true);
  });
  it('allows idempotent self-transition', () => {
    expect(canTransition(SYNC_STATE.QUEUED, SYNC_STATE.QUEUED)).toBe(true);
  });
});
