import { prisma } from '../../db/prisma';
import { queueStats } from '../sync/queue.service';

function pct(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[i];
}

// A few transient hung/slow calls against a busy external API are normal and must
// NOT paint the whole integration "DEGRADED". Only real signals do:
//   DOWN     — circuit OPEN or auth failing (actually broken)
//   DEGRADED — sustained error rate (<98% success/hour), circuit recovering,
//              slow p95, OR an unusual burst of hung calls (> SLOW_BURST)
// A handful of slow calls surfaces as a metric on the page, not as a status change.
const SLOW_BURST = 10;
function computeVerdict(x: { circuit: string; authOk: boolean; successRate: number; slowCount: number; p95?: number }): {
  verdict: 'HEALTHY' | 'DEGRADED' | 'DOWN';
  verdictReason: string;
} {
  if (x.circuit === 'OPEN') return { verdict: 'DOWN', verdictReason: 'Circuit breaker is OPEN — calls are being blocked' };
  if (!x.authOk) return { verdict: 'DOWN', verdictReason: 'Authentication is failing' };
  if (x.successRate < 98) return { verdict: 'DEGRADED', verdictReason: `Error rate elevated (${(100 - x.successRate).toFixed(1)}% of calls failing in the last hour)` };
  if (x.circuit === 'HALF_OPEN') return { verdict: 'DEGRADED', verdictReason: 'Circuit breaker is recovering (HALF_OPEN)' };
  if (x.p95 != null && x.p95 > 3000) return { verdict: 'DEGRADED', verdictReason: `Responses are slow (p95 = ${x.p95}ms)` };
  if (x.slowCount > SLOW_BURST) return { verdict: 'DEGRADED', verdictReason: `${x.slowCount} calls hung/timed out in the last hour` };
  const note = x.slowCount > 0 ? ` (${x.slowCount} slow call${x.slowCount > 1 ? 's' : ''} — within normal range)` : '';
  return { verdict: 'HEALTHY', verdictReason: `Reachable, low error rate, fast responses${note}` };
}

/**
 * FastTest integration health + efficiency snapshot.
 * Health = can we reach it and is it erroring? Efficiency = how fast / how well
 * are we using it (latency percentiles, throughput, token reuse, rate headroom).
 */
/**
 * Cheap live-status probe for the global top-bar badge (runs on every page, so
 * it must stay light — a few counts, no percentile scans). Same verdict logic as
 * the full health page minus the latency-percentile check.
 */
export async function getFastTestStatusLight() {
  const since1h = new Date(Date.now() - 60 * 60 * 1000);
  const [ws, winTotal, winFailures, slowCount] = await Promise.all([
    prisma.fastTestWorkspace.findFirst({ where: { deletedAt: null }, include: { circuitBreaker: true } }),
    prisma.apiRequestLog.count({ where: { requestedAt: { gte: since1h } } }),
    prisma.apiRequestLog.count({ where: { requestedAt: { gte: since1h }, success: false } }),
    prisma.apiRequestLog.count({ where: { requestedAt: { gte: since1h }, OR: [{ responseTimeMs: { gte: 30000 } }, { fastTestErrorCode: 'TIMEOUT' }] } }),
  ]);
  const circuit = ws?.circuitBreaker?.state ?? 'CLOSED';
  const authOk = ws?.lastAuthenticationStatus === 'SUCCESS';
  const successRate = winTotal > 0 ? Math.round(((winTotal - winFailures) / winTotal) * 10000) / 100 : 100;

  const { verdict, verdictReason } = computeVerdict({ circuit, authOk, successRate, slowCount });
  return { verdict, verdictReason, successRate, circuit, authOk, callsLastHour: winTotal, slowCount };
}

export async function getFastTestHealth() {
  const since1h = new Date(Date.now() - 60 * 60 * 1000);
  const since1m = new Date(Date.now() - 60 * 1000);

  // Health is a "how are we doing NOW" question, so the headline metrics use a
  // rolling 1-hour window. All-time totals are kept only as secondary context —
  // otherwise one bad hour (e.g. a full disk) would tank the success rate forever.
  const SLOW_MS = 30000; // a call slower than this is a hang/near-timeout, not real latency
  const [workspaces, agg, winAgg, recent, byEndpoint, byStatus, lastMinCount, authCount, winAuthCount, slowCount, rateRows, qs] = await Promise.all([
    prisma.fastTestWorkspace.findMany({
      where: { deletedAt: null },
      include: { circuitBreaker: true },
    }),
    // All-time (context only).
    prisma.apiRequestLog.aggregate({ _avg: { responseTimeMs: true }, _count: { _all: true }, _sum: { retryCount: true } }),
    // Rolling window (drives the headline health).
    prisma.apiRequestLog.aggregate({ where: { requestedAt: { gte: since1h } }, _count: { _all: true }, _sum: { retryCount: true } }),
    // Latency sample: SUCCESSFUL calls in the window only — excludes failed/hung
    // calls so a 17-minute timeout can't pollute the percentiles.
    prisma.apiRequestLog.findMany({
      where: { success: true, responseTimeMs: { not: null, lt: SLOW_MS }, requestedAt: { gte: since1h } },
      orderBy: { requestedAt: 'desc' },
      take: 5000,
      select: { responseTimeMs: true },
    }),
    prisma.apiRequestLog.groupBy({ by: ['endpoint'], _avg: { responseTimeMs: true }, _count: { _all: true }, where: { requestedAt: { gte: since1h } } }),
    prisma.apiRequestLog.groupBy({ by: ['httpStatus'], _count: { _all: true }, where: { success: false, requestedAt: { gte: since1h } } }),
    prisma.apiRequestLog.count({ where: { requestedAt: { gte: since1m } } }),
    prisma.apiRequestLog.count({ where: { endpoint: '/auth/simple' } }),
    prisma.apiRequestLog.count({ where: { endpoint: '/auth/simple', requestedAt: { gte: since1h } } }),
    prisma.apiRequestLog.count({ where: { requestedAt: { gte: since1h }, OR: [{ responseTimeMs: { gte: SLOW_MS } }, { fastTestErrorCode: 'TIMEOUT' }] } }),
    prisma.workspaceRateLimit.findMany(),
    queueStats().catch(() => null),
  ]);

  const total = agg._count._all || 0;
  const failures = await prisma.apiRequestLog.count({ where: { success: false } });
  // Windowed calls + failures (the numbers that actually reflect current health).
  const winTotal = winAgg._count._all || 0;
  const winFailures = await prisma.apiRequestLog.count({ where: { success: false, requestedAt: { gte: since1h } } });

  // Time series (last 30 min, per minute). UTC_TIMESTAMP avoids the session-TZ
  // vs stored-UTC mismatch that NOW() would introduce.
  const tsRows = await prisma.$queryRaw<Array<{ m: string; n: bigint; avgms: number | null }>>`
    SELECT DATE_FORMAT(requestedAt, '%H:%i') AS m, COUNT(*) AS n, AVG(responseTimeMs) AS avgms
    FROM ApiRequestLog
    WHERE requestedAt >= (UTC_TIMESTAMP() - INTERVAL 30 MINUTE)
    GROUP BY m ORDER BY m`;
  const timeSeries = tsRows.map((r) => ({ t: r.m, count: Number(r.n), avgMs: Math.round(Number(r.avgms) || 0) }));

  // Recent failures (detail log).
  const recentErrors = (await prisma.apiRequestLog.findMany({
    where: { success: false, requestedAt: { gte: since1h } },
    orderBy: { requestedAt: 'desc' },
    take: 50,
    select: { endpoint: true, httpStatus: true, fastTestErrorMessage: true, requestedAt: true, responseTimeMs: true },
  })).map((e) => ({ endpoint: e.endpoint, httpStatus: e.httpStatus, message: e.fastTestErrorMessage, at: e.requestedAt, ms: e.responseTimeMs }));

  // Data freshness: how recently each registration was successfully synced.
  const nowMs = Date.now();
  const d = (mins: number) => new Date(nowMs - mins * 60000);
  const [totalRegs, f5, f60, f24, syncedEver] = await Promise.all([
    prisma.examRegistration.count({ where: { deletedAt: null } }),
    prisma.examRegistration.count({ where: { lastSuccessfulSyncAt: { gte: d(5) } } }),
    prisma.examRegistration.count({ where: { lastSuccessfulSyncAt: { gte: d(60), lt: d(5) } } }),
    prisma.examRegistration.count({ where: { lastSuccessfulSyncAt: { gte: d(1440), lt: d(60) } } }),
    prisma.examRegistration.count({ where: { lastSuccessfulSyncAt: { not: null } } }),
  ]);
  const freshness = {
    last5m: f5,
    last1h: f60,
    last24h: f24,
    older: Math.max(0, syncedEver - f5 - f60 - f24),
    never: Math.max(0, totalRegs - syncedEver),
    total: totalRegs,
  };
  const successRate = total > 0 ? Math.round(((total - failures) / total) * 10000) / 100 : 100;
  // Windowed success rate = the health-critical number.
  const winSuccessRate = winTotal > 0 ? Math.round(((winTotal - winFailures) / winTotal) * 10000) / 100 : 100;

  const times = recent.map((r) => r.responseTimeMs as number).sort((a, b) => a - b);
  const avgClean = times.length ? Math.round(times.reduce((s, v) => s + v, 0) / times.length) : 0;
  const latency = {
    avg: avgClean, // mean of successful calls only (outliers excluded)
    p50: pct(times, 50),
    p95: pct(times, 95),
    p99: pct(times, 99),
    max: times.length ? times[times.length - 1] : 0,
    sampleCount: times.length,
  };

  // Token efficiency (windowed): fewer auth calls per data call = better reuse.
  const winDataCalls = Math.max(0, winTotal - winAuthCount);
  const tokenReuse = winAuthCount > 0 ? Math.round((winDataCalls / winAuthCount) * 10) / 10 : winDataCalls;

  // Rate headroom: recent throughput vs configured ceiling.
  const maxRps = rateRows.length ? Math.max(...rateRows.map((r) => r.maxRps)) : 0;
  const currentRps = Math.round((lastMinCount / 60) * 10) / 10;
  const rateUtil = maxRps > 0 ? Math.min(100, Math.round((currentRps / maxRps) * 100)) : 0;

  const ws = workspaces[0];
  const circuit = ws?.circuitBreaker?.state ?? 'CLOSED';
  const authOk = ws?.lastAuthenticationStatus === 'SUCCESS';

  // Overall health verdict — based on the ROLLING WINDOW, with an explicit reason.
  const { verdict, verdictReason } = computeVerdict({ circuit, authOk, successRate: winSuccessRate, slowCount, p95: latency.p95 });

  const errorsByStatus = byStatus
    .map((s) => ({ status: s.httpStatus ?? 0, count: s._count._all }))
    .sort((a, b) => b.count - a.count);

  return {
    verdict,
    verdictReason,
    windowMinutes: 60,
    workspace: ws ? { name: ws.workspaceName, baseUrl: ws.baseUrl, circuit, authOk, lastAuthAt: ws.lastAuthenticationAt, lastSyncAt: ws.lastSuccessfulSyncAt, syncEnabled: ws.syncEnabled, syncPaused: ws.syncPaused } : null,
    calls: {
      total, failures, successRate, // all-time (context)
      windowTotal: winTotal, windowFailures: winFailures, windowSuccessRate: winSuccessRate,
      callsLastMin: lastMinCount, retries: winAgg._sum.retryCount ?? 0, slowCount,
    },
    latency,
    throughput: { currentRps, maxRps, rateUtil },
    tokens: { authCalls: winAuthCount, dataCalls: winDataCalls, reuseRatio: tokenReuse },
    byEndpoint: byEndpoint.map((e) => ({ endpoint: e.endpoint, count: e._count._all, avgMs: Math.round(e._avg.responseTimeMs ?? 0) })).sort((a, b) => b.count - a.count),
    errorsByStatus,
    sync: qs ? { jobsLastMin: qs.jobsLastMin, running: qs.running, queued: qs.queued, failedLastMin: qs.failedLastMin } : null,
    timeSeries,
    recentErrors,
    freshness,
    since1h,
  };
}
