/**
 * Local queue performance benchmark. Generates N registrations + jobs and
 * drains the queue with a MOCK FastTest client — it NEVER calls FastTest.
 *
 * Usage: DATABASE_URL="file:./perf.db" npx ts-node --transpile-only scripts/perf/queue-bench.ts <N> <concurrency>
 * Prereq: run migrations against the same DATABASE_URL first.
 */
import { prisma } from '../../src/db/prisma';
import { FastTestClient } from '../../src/services/fasttest/client';
import { clearAllTokens } from '../../src/services/fasttest/token-cache';
import { resetBuckets, invalidateRateConfig } from '../../src/services/sync/rate-limiter.service';
import { enqueue } from '../../src/services/sync/queue.service';
import { processOneJob } from '../../src/workers/sync.worker';
import { encrypt } from '../../src/lib/crypto';
import { JOB_TYPE } from '../../src/lib/enums';

const N = Number(process.argv[2] ?? 100);
const CONCURRENCY = Number(process.argv[3] ?? 8);

// Mock transport: instant successful status. No network, no FastTest.
const transport = async (req: any) => {
  if (req.url.includes('/auth')) return { status: 200, ok: true, body: { apiToken: 'TOK', ttl: 3600 } };
  return { status: 200, ok: true, body: { status: 'INPROGRESS' } };
};

async function main() {
  console.log(`\n=== Queue benchmark: N=${N} concurrency=${CONCURRENCY} (mock client, no FastTest) ===`);

  // Clean slate.
  await prisma.syncJobAttempt.deleteMany({});
  await prisma.syncJob.deleteMany({});
  await prisma.fastTestResult.deleteMany({});
  await prisma.examRegistration.deleteMany({});
  clearAllTokens(); resetBuckets(); invalidateRateConfig();

  // Workspace with a generous rate limit so throughput is not artificially capped.
  const ws =
    (await prisma.fastTestWorkspace.findFirst({ where: { subjectCode: 'PERF' } })) ??
    (await prisma.fastTestWorkspace.create({ data: { workspaceName: 'Perf WS', subjectCode: 'PERF', baseUrl: 'https://x.test/api', restApiKeyEncrypted: encrypt('k'), syncEnabled: true } }));
  await prisma.workspaceRateLimit.upsert({
    where: { workspaceId: ws.id },
    create: { workspaceId: ws.id, maxRps: 100000, maxRpm: 10000000, maxConcurrent: CONCURRENCY, minDelayMs: 0, burst: 100000 },
    update: { maxRps: 100000, maxRpm: 10000000, maxConcurrent: CONCURRENCY, minDelayMs: 0, burst: 100000 },
  });
  await prisma.workspaceCircuitBreaker.deleteMany({ where: { workspaceId: ws.id } });
  invalidateRateConfig();

  // Generate registrations.
  const genStart = Date.now();
  const regRows = Array.from({ length: N }, (_, i) => ({
    studentExternalId: `PERF-${i}`, examSubject: 'Perf', testCodeNormalized: `PERF${i}`, testCodeOriginal: `PERF-${i}`,
    workspaceId: ws.id, dashboardStatus: 'UNKNOWN', syncState: 'PENDING',
  }));
  // createMany is fast; batch to avoid SQLite variable limits.
  for (let i = 0; i < regRows.length; i += 500) await prisma.examRegistration.createMany({ data: regRows.slice(i, i + 500) });
  const regs = await prisma.examRegistration.findMany({ where: { workspaceId: ws.id }, select: { id: true } });
  for (const r of regs) await enqueue({ jobType: JOB_TYPE.SYNC_REGISTRATION_STATUS, workspaceId: ws.id, registrationId: r.id, subject: 'Perf' });
  const genMs = Date.now() - genStart;

  const client = new FastTestClient({ transport, now: () => Date.now() });
  const memBefore = process.memoryUsage().rss / 1024 / 1024;

  // Drain with a bounded worker pool.
  let processed = 0;
  const start = Date.now();
  const worker = async (id: number) => {
    while (true) {
      const outcome = await processOneJob(`bench-${id}`, () => Date.now(), client);
      if (outcome === null) {
        const remaining = await prisma.syncJob.count({ where: { status: { in: ['QUEUED', 'RETRY_SCHEDULED'] } } });
        if (remaining === 0) break;
        continue;
      }
      processed++;
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => worker(i)));
  const durationMs = Date.now() - start;
  const memAfter = process.memoryUsage().rss / 1024 / 1024;

  // Verify exactly-once processing.
  const attempts = await prisma.syncJobAttempt.count();
  const done = await prisma.syncJob.count({ where: { status: 'DONE' } });
  const dupCheck = await prisma.$queryRawUnsafe<any[]>(
    `SELECT jobId, COUNT(*) c FROM SyncJobAttempt WHERE status='SUCCESS' GROUP BY jobId HAVING c > 1`,
  );

  console.log(`  generated ${N} regs+jobs in ${genMs} ms`);
  console.log(`  drained ${processed} jobs in ${durationMs} ms`);
  console.log(`  throughput: ${(processed / (durationMs / 1000)).toFixed(1)} jobs/sec`);
  console.log(`  avg processing: ${(durationMs / Math.max(1, processed)).toFixed(2)} ms/job`);
  console.log(`  DONE jobs: ${done} / ${N}`);
  console.log(`  success attempts: ${attempts} (duplicate-success jobs: ${dupCheck.length})`);
  console.log(`  memory: ${memBefore.toFixed(0)} → ${memAfter.toFixed(0)} MB`);
  console.log(`  exactly-once: ${dupCheck.length === 0 && done === N ? 'PASS ✅' : 'FAIL ❌'}`);

  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
