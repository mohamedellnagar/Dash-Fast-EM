import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '../../src/db/prisma';
import { transitionState } from '../../src/services/sync/state';
import { makeRegistration, clearRegistrations } from '../helpers/fixtures';
import { SYNC_STATE } from '../../src/lib/enums';

// QA for the DB-write reduction in the sync path (transitionState):
//  - fromState is trusted when passed (no read),
//  - skipHistory writes the state without a history row,
//  - meaningful transitions still record history,
//  - beginning a sync directly from a rest state works (no QUEUED bridge).
describe('QA: optimized sync-state transitions', () => {
  beforeEach(async () => {
    await clearRegistrations();
  });

  it('skipHistory updates the state but writes NO history row', async () => {
    const reg = await makeRegistration({ status: 'NOT_STARTED' });
    const before = await prisma.syncStateTransition.count({ where: { registrationId: reg.id } });

    const ok = await transitionState(reg.id, SYNC_STATE.SYNCING_STATUS, {
      fromState: reg.syncState, skipHistory: true,
    });

    expect(ok).toBe(true);
    const updated = await prisma.examRegistration.findUnique({ where: { id: reg.id } });
    expect(updated?.syncState).toBe(SYNC_STATE.SYNCING_STATUS); // state advanced
    const after = await prisma.syncStateTransition.count({ where: { registrationId: reg.id } });
    expect(after).toBe(before); // ...but no history row written
  });

  it('a meaningful transition still records a history row', async () => {
    const reg = await makeRegistration({ status: 'NOT_STARTED' });
    await transitionState(reg.id, SYNC_STATE.SYNCING_STATUS, { fromState: reg.syncState, skipHistory: true });

    const before = await prisma.syncStateTransition.count({ where: { registrationId: reg.id } });
    await transitionState(reg.id, SYNC_STATE.STATUS_SYNCED, { fromState: SYNC_STATE.SYNCING_STATUS });
    const after = await prisma.syncStateTransition.count({ where: { registrationId: reg.id } });

    expect(after).toBe(before + 1);
    const last = await prisma.syncStateTransition.findFirst({
      where: { registrationId: reg.id }, orderBy: { createdAt: 'desc' },
    });
    expect(last?.fromState).toBe(SYNC_STATE.SYNCING_STATUS);
    expect(last?.toState).toBe(SYNC_STATE.STATUS_SYNCED);
  });

  it('begins a sync directly from a rest state without the QUEUED bridge', async () => {
    const reg = await makeRegistration({ status: 'COMPLETED' });
    // Force a terminal-ish rest state, then begin a fresh sync straight from it.
    await prisma.examRegistration.update({ where: { id: reg.id }, data: { syncState: SYNC_STATE.COMPLETED } });

    const ok = await transitionState(reg.id, SYNC_STATE.SYNCING_STATUS, {
      fromState: SYNC_STATE.COMPLETED, skipHistory: true,
    });
    expect(ok).toBe(true);
    const updated = await prisma.examRegistration.findUnique({ where: { id: reg.id } });
    expect(updated?.syncState).toBe(SYNC_STATE.SYNCING_STATUS);
  });

  it('rejects an illegal transition and leaves the state untouched', async () => {
    const reg = await makeRegistration({ status: 'NOT_STARTED' });
    await prisma.examRegistration.update({ where: { id: reg.id }, data: { syncState: SYNC_STATE.MANUAL_REVIEW } });

    // MANUAL_REVIEW must never auto-begin syncing.
    const ok = await transitionState(reg.id, SYNC_STATE.SYNCING_STATUS, { fromState: SYNC_STATE.MANUAL_REVIEW });

    expect(ok).toBe(false);
    const updated = await prisma.examRegistration.findUnique({ where: { id: reg.id } });
    expect(updated?.syncState).toBe(SYNC_STATE.MANUAL_REVIEW); // unchanged
  });
});
