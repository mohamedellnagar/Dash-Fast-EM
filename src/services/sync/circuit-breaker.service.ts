import { prisma } from '../../db/prisma';
import { env } from '../../config/env';
import { CIRCUIT_STATE, ERROR_CATEGORY, ErrorCategory } from '../../lib/enums';
import { logger } from '../../lib/logger';

// Per-workspace circuit breaker. State persists in WorkspaceCircuitBreaker so
// it is shared across all workers. CLOSED → OPEN on repeated failures; OPEN
// blocks normal calls until nextProbeAt, then HALF_OPEN allows limited probes;
// a probe success closes the circuit, a probe failure re-opens it.

async function getOrCreate(workspaceId: string) {
  // Race-safe get-or-create under worker concurrency. `create` throws a PRIMARY
  // key violation when two workers insert at once — and Prisma logs that as a
  // `prisma:error` even when caught, spamming the logs. `createMany` with
  // skipDuplicates compiles to INSERT IGNORE: atomic and silent on conflict.
  const existing = await prisma.workspaceCircuitBreaker.findUnique({ where: { workspaceId } });
  if (existing) return existing;
  await prisma.workspaceCircuitBreaker.createMany({
    data: [{ workspaceId, state: CIRCUIT_STATE.CLOSED }],
    skipDuplicates: true,
  });
  const row = await prisma.workspaceCircuitBreaker.findUnique({ where: { workspaceId } });
  if (row) return row;
  throw new Error(`failed to get-or-create circuit breaker for ${workspaceId}`);
}

export interface BreakerDecision {
  allowed: boolean;
  state: string;
  probe: boolean; // true when this is a HALF_OPEN health probe
}

/** Decide whether a request may proceed for this workspace. */
export async function canRequest(workspaceId: string, now: () => number = () => Date.now()): Promise<BreakerDecision> {
  const cb = await getOrCreate(workspaceId);
  if (cb.state === CIRCUIT_STATE.CLOSED) return { allowed: true, state: cb.state, probe: false };

  if (cb.state === CIRCUIT_STATE.OPEN) {
    if (cb.nextProbeAt && now() >= cb.nextProbeAt.getTime()) {
      // Transition to HALF_OPEN and allow a probe.
      await prisma.workspaceCircuitBreaker.update({ where: { workspaceId }, data: { state: CIRCUIT_STATE.HALF_OPEN, successCount: 0 } });
      return { allowed: true, state: CIRCUIT_STATE.HALF_OPEN, probe: true };
    }
    return { allowed: false, state: CIRCUIT_STATE.OPEN, probe: false };
  }

  // HALF_OPEN: allow limited probes.
  return { allowed: true, state: CIRCUIT_STATE.HALF_OPEN, probe: true };
}

export async function recordSuccess(workspaceId: string): Promise<void> {
  const cb = await getOrCreate(workspaceId);
  if (cb.state === CIRCUIT_STATE.CLOSED) {
    if (cb.failureCount > 0) await prisma.workspaceCircuitBreaker.update({ where: { workspaceId }, data: { failureCount: 0 } });
    return;
  }
  if (cb.state === CIRCUIT_STATE.HALF_OPEN) {
    const successCount = cb.successCount + 1;
    if (successCount >= env.circuit.halfOpenProbes) {
      await prisma.workspaceCircuitBreaker.update({
        where: { workspaceId },
        data: { state: CIRCUIT_STATE.CLOSED, failureCount: 0, successCount: 0, openedAt: null, nextProbeAt: null, lastTrippedReason: null },
      });
      logger.info({ workspaceId }, 'circuit closed (recovered)');
    } else {
      await prisma.workspaceCircuitBreaker.update({ where: { workspaceId }, data: { successCount } });
    }
  }
}

const AUTH_CATEGORIES: ErrorCategory[] = [ERROR_CATEGORY.AUTHENTICATION, ERROR_CATEGORY.TOKEN_EXPIRED];

// Categories that reflect OUR infrastructure (a failing local DB/disk) or a
// single registration's data — NOT FastTest's health. These must never trip or
// re-open the FastTest circuit: a full disk or one bad test code is not FastTest
// being down. Genuine FastTest signals (timeout, network, 5xx, auth) still trip.
const NON_FASTTEST_CATEGORIES: ErrorCategory[] = [
  ERROR_CATEGORY.DATABASE,
  ERROR_CATEGORY.NOT_FOUND,
  ERROR_CATEGORY.INVALID_TEST_CODE,
  ERROR_CATEGORY.WORKSPACE_MISMATCH,
];

export async function recordFailure(workspaceId: string, category: ErrorCategory, now: () => number = () => Date.now()): Promise<boolean> {
  // Infrastructure/data errors don't say anything about FastTest — ignore them.
  if (NON_FASTTEST_CATEGORIES.includes(category)) return false;

  const cb = await getOrCreate(workspaceId);
  const failureCount = cb.failureCount + 1;

  // HALF_OPEN probe failed → re-open immediately.
  if (cb.state === CIRCUIT_STATE.HALF_OPEN) {
    await open(workspaceId, `half-open probe failed (${category})`, now);
    return true;
  }

  const authTrip = AUTH_CATEGORIES.includes(category) && failureCount >= env.circuit.authFailThreshold;
  const timeoutTrip = category === ERROR_CATEGORY.TIMEOUT && failureCount >= env.circuit.timeoutThreshold;
  const genTrip = failureCount >= env.circuit.failureThreshold;

  if (cb.state === CIRCUIT_STATE.CLOSED && (authTrip || timeoutTrip || genTrip)) {
    await open(workspaceId, `threshold exceeded (${category}, ${failureCount} failures)`, now);
    return true;
  }
  await prisma.workspaceCircuitBreaker.update({ where: { workspaceId }, data: { failureCount } });
  return false;
}

async function open(workspaceId: string, reason: string, now: () => number) {
  await prisma.workspaceCircuitBreaker.update({
    where: { workspaceId },
    data: { state: CIRCUIT_STATE.OPEN, openedAt: new Date(now()), nextProbeAt: new Date(now() + env.circuit.openMs), lastTrippedReason: reason },
  });
  logger.warn({ workspaceId, reason }, 'circuit OPEN');
}

export async function getCircuitState(workspaceId: string): Promise<string> {
  const cb = await prisma.workspaceCircuitBreaker.findUnique({ where: { workspaceId } });
  return cb?.state ?? CIRCUIT_STATE.CLOSED;
}
