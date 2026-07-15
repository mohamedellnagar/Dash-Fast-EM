import { prisma } from '../../db/prisma';
import { canTransition } from '../../lib/sync-state';
import { logger } from '../../lib/logger';

/**
 * Transition a registration's formal sync state, persisting the transition
 * history. Invalid transitions are logged and skipped (state left unchanged).
 */
export async function transitionState(
  registrationId: string,
  toState: string,
  opts: { fromState?: string; jobId?: string; reason?: string; correlationId?: string } = {},
): Promise<boolean> {
  const reg = opts.fromState
    ? { syncState: opts.fromState }
    : await prisma.examRegistration.findUnique({ where: { id: registrationId }, select: { syncState: true } });
  const fromState = reg?.syncState ?? 'PENDING';
  if (!canTransition(fromState, toState)) {
    logger.debug({ registrationId, fromState, toState }, 'invalid sync-state transition skipped');
    return false;
  }
  await prisma.$transaction([
    prisma.examRegistration.update({ where: { id: registrationId }, data: { syncState: toState } }),
    prisma.syncStateTransition.create({
      data: { registrationId, jobId: opts.jobId ?? null, fromState, toState, reason: opts.reason ?? null, correlationId: opts.correlationId ?? null },
    }),
  ]);
  return true;
}
