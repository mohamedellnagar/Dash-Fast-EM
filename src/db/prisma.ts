import { PrismaClient } from '@prisma/client';
import { env } from '../config/env';

// Ensure the MySQL connection pool is big enough for the worker's concurrent
// runners (+ heartbeats, scheduler, SSE). Prisma's default is num_cpus*2+1,
// which a container often sees as only a handful — far fewer than the ~20
// runners, so queries queue waiting for a connection and throughput collapses.
// Size it from the configured concurrency unless the URL already sets a limit.
function withConnectionLimit(url: string): string {
  if (!url.startsWith('mysql') || /[?&]connection_limit=/.test(url)) return url;
  // Give the runner pool real headroom: every runner can be mid-query at once,
  // plus heartbeats and the scheduler. Too small a pool makes runners wait on a
  // connection and throttles throughput. 2x concurrency stays well under MySQL's
  // default max_connections (151) even with web + a deploy-time second worker
  // (e.g. 40 x 3 = 120 < 151 at the default concurrency of 20).
  const limit = Math.max(20, env.sync.concurrency * 2);
  return url + (url.includes('?') ? '&' : '?') + `connection_limit=${limit}&pool_timeout=20`;
}

// Single shared Prisma client. In tests a distinct DATABASE_URL points at a
// throwaway SQLite file so runs never touch dev data.
export const prisma = new PrismaClient({
  log: env.isProd ? ['warn', 'error'] : ['warn', 'error'],
  datasources: { db: { url: withConnectionLimit(env.databaseUrl) } },
});

export async function disconnectPrisma(): Promise<void> {
  await prisma.$disconnect();
}
