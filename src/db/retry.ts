// Retry helper for transient MySQL/InnoDB write conflicts and deadlocks.
//
// Under worker concurrency, concurrent row updates on the SyncJob queue can
// deadlock (InnoDB) or hit a write conflict. Prisma surfaces these as error
// code P2034 (or a message mentioning "deadlock" / "write conflict"). They are
// safe to retry: re-run the same write after a short randomized backoff.

const DEADLOCK_RE = /deadlock|write conflict|try restarting transaction/i;

function isTransientWriteConflict(e: unknown): boolean {
  const err = e as { code?: string; message?: string };
  return err?.code === 'P2034' || DEADLOCK_RE.test(String(err?.message ?? ''));
}

/** Run `fn`, retrying up to `attempts` times on a deadlock / write conflict. */
export async function retryOnDeadlock<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      if (!isTransientWriteConflict(e) || i === attempts - 1) throw e;
      lastErr = e;
      const backoffMs = 20 * (i + 1) + Math.floor(Math.random() * 25);
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }
  throw lastErr;
}
