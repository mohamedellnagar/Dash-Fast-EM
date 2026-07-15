import { prisma } from '../../db/prisma';
import { logger } from '../../lib/logger';

// Distributed lock backed by the DistributedLock table. Works identically on
// SQLite (dev) and PostgreSQL (prod) with no extra infrastructure.
//
// Correctness:
//  - First acquisition is an atomic unique INSERT on the primary key `key` —
//    only one caller can win a fresh lock.
//  - Takeover of an EXPIRED lock uses a guarded updateMany (expiresAt < now)
//    followed by read-after-write owner verification, which resolves the
//    concurrent-takeover race (the persisted owner is authoritative).
//  - Locks carry owner + expiresAt + heartbeatAt so a crashed holder's lock is
//    reclaimable after expiry (recovery), and long operations renew via
//    heartbeat so they are not stolen mid-flight.
// On PostgreSQL this can be further hardened with pg_advisory_xact_lock; the
// table approach is the portable default (see docs/SYNC_ARCHITECTURE.md).

export async function acquireLock(key: string, owner: string, ttlMs: number, now: () => number = () => Date.now()): Promise<boolean> {
  const t = now();
  const expiresAt = new Date(t + ttlMs);
  try {
    await prisma.distributedLock.create({ data: { key, owner, acquiredAt: new Date(t), heartbeatAt: new Date(t), expiresAt } });
    return true;
  } catch {
    // Lock row exists — attempt to take over only if it has expired.
    const upd = await prisma.distributedLock.updateMany({
      where: { key, expiresAt: { lt: new Date(t) } },
      data: { owner, acquiredAt: new Date(t), heartbeatAt: new Date(t), expiresAt },
    });
    if (upd.count === 0) return false; // still held and not expired
    const row = await prisma.distributedLock.findUnique({ where: { key } });
    return row?.owner === owner; // read-after-write ownership verification
  }
}

export async function renewLock(key: string, owner: string, ttlMs: number, now: () => number = () => Date.now()): Promise<boolean> {
  const t = now();
  const upd = await prisma.distributedLock.updateMany({
    where: { key, owner },
    data: { heartbeatAt: new Date(t), expiresAt: new Date(t + ttlMs) },
  });
  return upd.count > 0;
}

export async function releaseLock(key: string, owner: string): Promise<void> {
  await prisma.distributedLock.deleteMany({ where: { key, owner } });
}

/** Run `fn` while holding `key`; auto-renews via heartbeat; always releases. */
export async function withLock<T>(
  key: string,
  owner: string,
  ttlMs: number,
  fn: () => Promise<T>,
): Promise<{ acquired: boolean; result?: T }> {
  const got = await acquireLock(key, owner, ttlMs);
  if (!got) return { acquired: false };
  const heartbeat = setInterval(() => {
    renewLock(key, owner, ttlMs).catch((e) => logger.warn({ key, err: (e as Error).message }, 'lock renew failed'));
  }, Math.max(1000, Math.floor(ttlMs / 2)));
  try {
    const result = await fn();
    return { acquired: true, result };
  } finally {
    clearInterval(heartbeat);
    await releaseLock(key, owner).catch(() => undefined);
  }
}

/** Reclaim expired locks (called by recovery sweeps). Returns count removed. */
export async function reapExpiredLocks(now: () => number = () => Date.now()): Promise<number> {
  const res = await prisma.distributedLock.deleteMany({ where: { expiresAt: { lt: new Date(now()) } } });
  return res.count;
}
