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
    expect(canTransition(SYNC_STATE.COMPLETED, SYNC_STATE.SYNCING_RESULTS)).toBe(false);
    expect(canTransition(SYNC_STATE.STATUS_SYNCED, SYNC_STATE.AUTH_FAILED)).toBe(false);
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
