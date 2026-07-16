import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import { prisma } from '../../src/db/prisma';
import { computeScheduling, enqueueDueJobs, isActiveExamWindow } from '../../src/services/sync/scheduler.service';
import { POLL_INTERVALS_SECONDS } from '../../src/services/sync/policy';
import { DASHBOARD_STATUS } from '../../src/lib/enums';
import { makeRegistration, clearRegistrations } from '../helpers/fixtures';
import { setSyncMode } from '../../src/services/sync/queue.service';

const NOW = Date.parse('2026-09-03T10:00:00Z');

describe('Scheduler policy', () => {
  it('detects active exam window', () => {
    expect(isActiveExamWindow({ startDate: '2026-09-01', endDate: '2026-09-05' }, NOW)).toBe(true);
    expect(isActiveExamWindow({ startDate: '2026-09-10', endDate: '2026-09-15' }, NOW)).toBe(false);
  });

  it('IN_PROGRESS polls fast', () => {
    const s = computeScheduling({ id: 'r', dashboardStatus: DASHBOARD_STATUS.IN_PROGRESS, startDate: null, endDate: null, lastSuccessfulSyncAt: null, nextSyncAt: null, hasResults: false }, NOW);
    expect(s.nextSyncAt.getTime()).toBe(NOW + POLL_INTERVALS_SECONDS.IN_PROGRESS * 1000);
    expect(s.requiresStatusFetch).toBe(true);
  });

  it('NOT_STARTED polls faster during the active window', () => {
    const active = computeScheduling({ id: 'r', dashboardStatus: DASHBOARD_STATUS.NOT_STARTED, startDate: '2026-09-01', endDate: '2026-09-05', lastSuccessfulSyncAt: null, nextSyncAt: null, hasResults: false }, NOW);
    expect(active.nextSyncAt.getTime()).toBe(NOW + POLL_INTERVALS_SECONDS.NOT_STARTED_ACTIVE_WINDOW * 1000);
    expect(active.isActiveExamWindow).toBe(true);
  });

  it('stops frequent polling once completed with results, and does not require fetches', () => {
    const s = computeScheduling({ id: 'r', dashboardStatus: DASHBOARD_STATUS.COMPLETED, startDate: null, endDate: null, lastSuccessfulSyncAt: new Date(NOW), nextSyncAt: null, hasResults: true }, NOW);
    expect(s.requiresStatusFetch).toBe(false);
    expect(s.requiresResultsFetch).toBe(false);
    // Completed + results is TERMINAL: nextSyncAt is pushed ~100 years out so the
    // scheduler never re-picks it (not the COMPLETED poll interval anymore).
    expect(s.nextSyncAt.getTime()).toBeGreaterThan(NOW + 50 * 365 * 24 * 60 * 60 * 1000);
  });

  it('requires a results fetch when completed without results', () => {
    const s = computeScheduling({ id: 'r', dashboardStatus: DASHBOARD_STATUS.COMPLETED, startDate: null, endDate: null, lastSuccessfulSyncAt: null, nextSyncAt: null, hasResults: false }, NOW);
    expect(s.requiresResultsFetch).toBe(true);
  });

  it('flags stale when no successful sync during an active window', () => {
    const s = computeScheduling({ id: 'r', dashboardStatus: DASHBOARD_STATUS.IN_PROGRESS, startDate: '2026-09-01', endDate: '2026-09-05', lastSuccessfulSyncAt: new Date(NOW - 100 * 60 * 1000), nextSyncAt: null, hasResults: false }, NOW);
    expect(s.isStale).toBe(true);
    expect(s.staleSeverity).toBe('HIGH');
  });
});

describe('Scheduler enqueue', () => {
  let wsId: string;
  beforeAll(async () => {
    wsId = (await prisma.fastTestWorkspace.create({ data: { workspaceName: 'Sched WS', subjectCode: 'SCHED', baseUrl: 'https://x.test/api', syncEnabled: true } })).id;
  });
  beforeEach(async () => {
    await clearRegistrations();
    await prisma.syncJob.deleteMany({});
  });

  it('enqueues due registrations and dedupes on a second pass', async () => {
    await makeRegistration({ workspaceId: wsId, status: 'IN_PROGRESS', examSubject: 'SchedSub' });
    await makeRegistration({ workspaceId: wsId, status: 'NOT_STARTED', examSubject: 'SchedSub' });
    const first = await enqueueDueJobs(() => Date.now());
    expect(first.enqueued).toBe(2);
    const second = await enqueueDueJobs(() => Date.now());
    expect(second.enqueued).toBe(0); // already scheduled forward + deduped
    expect(second.deduped).toBeGreaterThanOrEqual(0);
  });

  it('skips registrations whose workspace is paused', async () => {
    const paused = (await prisma.fastTestWorkspace.create({ data: { workspaceName: 'Paused WS', subjectCode: 'PAUSED', baseUrl: 'https://x.test/api', syncEnabled: true, syncPaused: true } })).id;
    await makeRegistration({ workspaceId: paused, status: 'IN_PROGRESS', examSubject: 'PausedSub' });
    const r = await enqueueDueJobs(() => Date.now());
    expect(r.enqueued).toBe(0);
  });

  it('SWEEP mode enqueues every non-terminal code and skips COMPLETED-with-results', async () => {
    await setSyncMode('SWEEP');
    try {
      // Two non-terminal (should be swept) — with a far-future nextSyncAt to prove
      // SWEEP ignores nextSyncAt gating.
      const a = await makeRegistration({ workspaceId: wsId, status: 'IN_PROGRESS', examSubject: 'SwSub' });
      const b = await makeRegistration({ workspaceId: wsId, status: 'NOT_STARTED', examSubject: 'SwSub' });
      await prisma.examRegistration.updateMany({ where: { id: { in: [a.id, b.id] } }, data: { nextSyncAt: new Date(Date.now() + 1e10) } });
      // Terminal: COMPLETED + a result row → must be skipped.
      await makeRegistration({ workspaceId: wsId, status: 'COMPLETED', examSubject: 'SwSub', result: { secondsUsed: 100 } });

      const r = await enqueueDueJobs(() => Date.now());
      expect(r.enqueued).toBe(2); // the two non-terminal only; terminal skipped
    } finally {
      await setSyncMode('ADAPTIVE'); // restore so other tests aren't affected
    }
  });
});
