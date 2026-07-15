import { prisma } from '../../db/prisma';

// Master kill-switch for ALL FastTest communication. When frozen, every outbound
// FastTest call (auth, status, results, connection test) is blocked at the client,
// and the sync worker/scheduler stop claiming jobs. Independent of the per-queue
// pause so it also stops manual syncs and connection tests.

const KEY = 'fasttest.frozen';
let cache: { at: number; frozen: boolean } | null = null;
const TTL_MS = 4000;

export async function isFastTestFrozen(): Promise<boolean> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.frozen;
  const row = await prisma.systemSetting.findUnique({ where: { key: KEY } }).catch(() => null);
  const frozen = row?.value === 'true';
  cache = { at: Date.now(), frozen };
  return frozen;
}

export async function setFastTestFrozen(frozen: boolean, by?: string): Promise<void> {
  await prisma.systemSetting.upsert({
    where: { key: KEY },
    create: { key: KEY, value: frozen ? 'true' : 'false' },
    update: { value: frozen ? 'true' : 'false' },
  });
  cache = { at: Date.now(), frozen }; // reflect immediately (don't wait for TTL)
  void by;
}

/** Synchronous helper for the client guard — throws if frozen. */
export async function assertFastTestNotFrozen(): Promise<void> {
  if (await isFastTestFrozen()) {
    const err = new Error('FastTest operations are stopped (master switch is ON)');
    (err as { code?: string }).code = 'FASTTEST_FROZEN';
    throw err;
  }
}

// Independent switch for the manual Connection Test only. Lets an operator block
// ad-hoc connection tests (which authenticate against FastTest) without freezing
// the whole sync pipeline. The master freeze still blocks connection tests too;
// this is the narrower, sync-independent control.
const CONN_TEST_KEY = 'fasttest.connectionTestDisabled';
let connTestCache: { at: number; disabled: boolean } | null = null;

export async function isConnectionTestDisabled(): Promise<boolean> {
  if (connTestCache && Date.now() - connTestCache.at < TTL_MS) return connTestCache.disabled;
  const row = await prisma.systemSetting.findUnique({ where: { key: CONN_TEST_KEY } }).catch(() => null);
  const disabled = row?.value === 'true';
  connTestCache = { at: Date.now(), disabled };
  return disabled;
}

export async function setConnectionTestDisabled(disabled: boolean, by?: string): Promise<void> {
  await prisma.systemSetting.upsert({
    where: { key: CONN_TEST_KEY },
    create: { key: CONN_TEST_KEY, value: disabled ? 'true' : 'false' },
    update: { value: disabled ? 'true' : 'false' },
  });
  connTestCache = { at: Date.now(), disabled }; // reflect immediately
  void by;
}

/** Throws if the connection test is disabled (independently of the master freeze). */
export async function assertConnectionTestEnabled(): Promise<void> {
  if (await isConnectionTestDisabled()) {
    const err = new Error('Connection Test is turned off by an administrator');
    (err as { code?: string }).code = 'CONNECTION_TEST_DISABLED';
    throw err;
  }
}
