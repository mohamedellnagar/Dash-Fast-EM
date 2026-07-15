import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '../../src/db/prisma';
import { acquireLock, renewLock, releaseLock, reapExpiredLocks, withLock } from '../../src/services/sync/lock.service';

beforeEach(async () => {
  await prisma.distributedLock.deleteMany({});
});

describe('Distributed lock', () => {
  it('grants a lock to exactly one owner', async () => {
    const t = 1_000_000;
    const a = await acquireLock('k1', 'ownerA', 10000, () => t);
    const b = await acquireLock('k1', 'ownerB', 10000, () => t);
    expect(a).toBe(true);
    expect(b).toBe(false);
  });

  it('lets the owner renew and release', async () => {
    const t = 1_000_000;
    await acquireLock('k2', 'ownerA', 10000, () => t);
    expect(await renewLock('k2', 'ownerA', 10000, () => t + 1000)).toBe(true);
    expect(await renewLock('k2', 'ownerB', 10000, () => t + 1000)).toBe(false); // not owner
    await releaseLock('k2', 'ownerA');
    expect(await acquireLock('k2', 'ownerB', 10000, () => t + 2000)).toBe(true);
  });

  it('allows takeover only after expiry', async () => {
    const t = 1_000_000;
    await acquireLock('k3', 'ownerA', 5000, () => t);
    // before expiry
    expect(await acquireLock('k3', 'ownerB', 5000, () => t + 4000)).toBe(false);
    // after expiry
    expect(await acquireLock('k3', 'ownerB', 5000, () => t + 6000)).toBe(true);
    const row = await prisma.distributedLock.findUnique({ where: { key: 'k3' } });
    expect(row!.owner).toBe('ownerB');
  });

  it('reaps expired locks', async () => {
    const t = 1_000_000;
    await acquireLock('k4', 'o', 1000, () => t);
    const reaped = await reapExpiredLocks(() => t + 5000);
    expect(reaped).toBeGreaterThanOrEqual(1);
  });

  it('withLock runs fn under mutual exclusion and releases', async () => {
    const r = await withLock('k5', 'o1', 10000, async () => 'ran');
    expect(r).toEqual({ acquired: true, result: 'ran' });
    // released → can be re-acquired
    expect(await acquireLock('k5', 'o2', 10000)).toBe(true);
  });
});
