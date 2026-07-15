import { prisma } from '../../db/prisma';
import { env } from '../../config/env';
import { ALERT_TYPE, AlertType, CIRCUIT_STATE, WORKER_STATUS } from '../../lib/enums';
import { logger } from '../../lib/logger';

// Internal operational alerts. Alerts dedupe on `dedupeKey` (one OPEN alert per
// condition) and increment occurrences on recurrence. External delivery is NOT
// performed unless a hook is registered — hooks are the extension point for
// email/Teams later.

export type AlertHook = (alert: { alertType: string; severity: string; title: string; detail?: string | null; workspaceId?: string | null }) => Promise<void> | void;
const hooks: AlertHook[] = [];
export function registerAlertHook(hook: AlertHook) {
  hooks.push(hook);
}

export interface RaiseAlertInput {
  alertType: AlertType;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  title: string;
  detail?: string;
  workspaceId?: string | null;
  dedupeKey?: string;
}

export async function raiseAlert(input: RaiseAlertInput): Promise<void> {
  const dedupeKey = input.dedupeKey ?? `${input.alertType}:${input.workspaceId ?? 'global'}`;
  // dedupeKey is globally unique, so look it up directly (including RESOLVED rows
  // so a recurring condition re-opens the same alert instead of colliding).
  const existing = await prisma.systemAlert.findUnique({ where: { dedupeKey } });
  let firstOpen = false;

  if (existing) {
    const reopen = existing.status === 'RESOLVED';
    await prisma.systemAlert.update({
      where: { dedupeKey },
      data: {
        occurrences: { increment: 1 }, lastSeenAt: new Date(), severity: input.severity,
        ...(reopen ? { status: 'OPEN', resolvedAt: null, resolvedBy: null, title: input.title, detail: input.detail ?? null } : {}),
      },
    });
    firstOpen = reopen;
  } else {
    try {
      await prisma.systemAlert.create({
        data: {
          alertType: input.alertType, severity: input.severity, title: input.title,
          detail: input.detail ?? null, workspaceId: input.workspaceId ?? null, dedupeKey,
        },
      });
      firstOpen = true;
    } catch (e) {
      // A concurrent detector created it first — fall back to an increment.
      if ((e as { code?: string }).code === 'P2002') {
        await prisma.systemAlert.update({ where: { dedupeKey }, data: { occurrences: { increment: 1 }, lastSeenAt: new Date(), severity: input.severity } });
      } else throw e;
    }
  }

  if (firstOpen) {
    for (const hook of hooks) {
      try {
        await hook(input);
      } catch (e) {
        logger.warn({ err: (e as Error).message }, 'alert hook failed');
      }
    }
  }
}

export async function listAlerts(status?: string, limit = 100) {
  return prisma.systemAlert.findMany({
    where: status ? { status } : {},
    orderBy: [{ status: 'asc' }, { severity: 'asc' }, { lastSeenAt: 'desc' }],
    take: limit,
    include: { workspace: { select: { workspaceName: true } }, assignedTo: { select: { fullName: true } }, notes: { orderBy: { createdAt: 'desc' } } },
  });
}

export async function acknowledgeAlert(id: string) {
  return prisma.systemAlert.update({ where: { id }, data: { status: 'ACKNOWLEDGED', acknowledgedAt: new Date() } });
}
export async function resolveAlert(id: string, by?: string) {
  return prisma.systemAlert.update({ where: { id }, data: { status: 'RESOLVED', resolvedAt: new Date(), resolvedBy: by ?? null } });
}
export async function assignAlert(id: string, userId: string | null) {
  return prisma.systemAlert.update({ where: { id }, data: { assignedToUserId: userId } });
}
export async function addAlertNote(alertId: string, note: string, userId?: string, email?: string) {
  return prisma.alertNote.create({ data: { alertId, note: note.slice(0, 2000), authorUserId: userId ?? null, authorEmail: email ?? null } });
}
export async function alertSummary() {
  const open = await prisma.systemAlert.groupBy({ by: ['severity'], where: { status: { not: 'RESOLVED' } }, _count: { _all: true } });
  return { total: open.reduce((s, r) => s + r._count._all, 0), bySeverity: Object.fromEntries(open.map((r) => [r.severity, r._count._all])) };
}

/** Evaluate alert conditions from current state and raise/dedupe alerts. */
// Alert types managed by the detectors below — eligible for auto-resolve when
// their condition no longer holds in a detector cycle.
const DETECTOR_MANAGED: string[] = [
  ALERT_TYPE.CIRCUIT_OPENED, ALERT_TYPE.QUEUE_BACKLOG, ALERT_TYPE.DEAD_LETTER_JOBS,
  ALERT_TYPE.STALE_WORKER, ALERT_TYPE.HIGH_STALE_COUNT, ALERT_TYPE.WORKSPACE_AUTH_FAILURE,
  ALERT_TYPE.SYNC_STOPPED,
];

export async function runAlertDetectors(now: () => number = () => Date.now()): Promise<number> {
  let raised = 0;
  const raisedKeys = new Set<string>();
  const raise = async (i: RaiseAlertInput) => {
    await raiseAlert(i);
    raisedKeys.add(i.dedupeKey ?? `${i.alertType}:${i.workspaceId ?? 'global'}`);
    raised++;
  };

  const workspaces = await prisma.fastTestWorkspace.findMany({ where: { deletedAt: null } });
  for (const w of workspaces) {
    if (w.lastAuthenticationStatus === 'FAILED' && w.authenticationFailureCount >= env.circuit.authFailThreshold) {
      await raise({ alertType: ALERT_TYPE.WORKSPACE_AUTH_FAILURE, severity: 'HIGH', workspaceId: w.id, title: `Authentication failing for ${w.workspaceName}`, detail: w.lastAuthenticationError ?? undefined });
    }
    if (w.syncPaused) {
      await raise({ alertType: ALERT_TYPE.SYNC_STOPPED, severity: 'MEDIUM', workspaceId: w.id, title: `Sync paused for ${w.workspaceName}` });
    }
  }

  const openBreakers = await prisma.workspaceCircuitBreaker.findMany({ where: { state: CIRCUIT_STATE.OPEN }, include: { workspace: true } });
  for (const cb of openBreakers) {
    await raise({ alertType: ALERT_TYPE.CIRCUIT_OPENED, severity: 'HIGH', workspaceId: cb.workspaceId, title: `Circuit OPEN for ${cb.workspace.workspaceName}`, detail: cb.lastTrippedReason ?? undefined });
  }

  // Queue backlog + dead-letter.
  const [queued, deadLetter, oldest] = await Promise.all([
    prisma.syncJob.count({ where: { status: 'QUEUED' } }),
    prisma.syncJob.count({ where: { status: 'DEAD_LETTER' } }),
    prisma.syncJob.findFirst({ where: { status: 'QUEUED' }, orderBy: { scheduledAt: 'asc' }, select: { scheduledAt: true } }),
  ]);
  if (queued > 1000 || (oldest && now() - oldest.scheduledAt.getTime() > 10 * 60 * 1000)) {
    await raise({ alertType: ALERT_TYPE.QUEUE_BACKLOG, severity: 'MEDIUM', title: `Queue backlog: ${queued} queued`, detail: `oldest job age ${oldest ? Math.round((now() - oldest.scheduledAt.getTime()) / 60000) : 0}m` });
  }
  if (deadLetter > 0) {
    await raise({ alertType: ALERT_TYPE.DEAD_LETTER_JOBS, severity: 'HIGH', title: `${deadLetter} dead-letter job(s)` });
  }

  // Stale workers.
  const staleWorkers = await prisma.workerInstance.count({ where: { status: { in: [WORKER_STATUS.STALE, WORKER_STATUS.OFFLINE] } } });
  if (staleWorkers > 0) await raise({ alertType: ALERT_TYPE.STALE_WORKER, severity: 'MEDIUM', title: `${staleWorkers} stale/offline worker(s)` });

  // High stale registration count.
  const staleRegs = await prisma.examRegistration.count({ where: { isStale: true, deletedAt: null } });
  if (staleRegs > 100) await raise({ alertType: ALERT_TYPE.HIGH_STALE_COUNT, severity: 'MEDIUM', title: `${staleRegs} stale registrations` });

  // Auto-resolve: any managed alert still OPEN/ACK but NOT re-raised this cycle
  // means its condition has cleared — close it automatically.
  const openManaged = await prisma.systemAlert.findMany({
    where: { alertType: { in: DETECTOR_MANAGED }, status: { not: 'RESOLVED' } },
    select: { id: true, dedupeKey: true },
  });
  for (const a of openManaged) {
    if (!a.dedupeKey || !raisedKeys.has(a.dedupeKey)) {
      await prisma.systemAlert.update({
        where: { id: a.id },
        data: { status: 'RESOLVED', resolvedAt: new Date(), resolvedBy: 'auto - condition cleared' },
      });
    }
  }

  return raised;
}

// Default hook: structured log (no external delivery).
registerAlertHook((a) => logger.warn({ alert: a.alertType, severity: a.severity, workspace: a.workspaceId }, `ALERT: ${a.title}`));
