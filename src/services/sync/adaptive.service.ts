import { prisma } from '../../db/prisma';
import { env } from '../../config/env';

// Adaptive request control. Computes a per-workspace "throttle" multiplier in
// [minThrottle, 1] from rolling API metrics (avg/percentile latency + error
// rate over a recent window). Under stress the multiplier drops, which the rate
// limiter multiplies into effective rps/rpm and inflates min-delay. When the
// workspace is healthy again the multiplier climbs back toward 1 (never above).

export interface RollingStats {
  count: number;
  avgMs: number;
  p50: number;
  p95: number;
  p99: number;
  errorRate: number;
  timeoutRate: number;
  http401: number;
  http404: number;
  http429: number;
  http500: number;
}

const WINDOW_MS = 120000; // 2 minutes

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

export async function rollingStats(workspaceId: string, now: () => number = () => Date.now()): Promise<RollingStats> {
  const since = new Date(now() - WINDOW_MS);
  const logs = await prisma.apiRequestLog.findMany({
    where: { workspaceId, requestedAt: { gte: since } },
    select: { responseTimeMs: true, success: true, httpStatus: true, fastTestErrorCode: true },
    take: 5000,
  });
  const durations = logs.map((l) => l.responseTimeMs ?? 0).sort((a, b) => a - b);
  const count = logs.length;
  const failures = logs.filter((l) => !l.success).length;
  const timeouts = logs.filter((l) => l.fastTestErrorCode === 'TIMEOUT' || l.httpStatus === 0).length;
  const by = (code: number) => logs.filter((l) => l.httpStatus === code).length;
  return {
    count,
    avgMs: count ? Math.round(durations.reduce((s, d) => s + d, 0) / count) : 0,
    p50: percentile(durations, 50),
    p95: percentile(durations, 95),
    p99: percentile(durations, 99),
    errorRate: count ? failures / count : 0,
    timeoutRate: count ? timeouts / count : 0,
    http401: by(401), http404: by(404), http429: by(429), http500: by(500),
  };
}

// Per-workspace adaptive memory (in-process; converges from DB stats each call).
const state = new Map<string, { throttle: number; lastDegradeAt: number }>();

/** Return the current throttle multiplier for a workspace, updating from stats. */
export async function currentThrottle(workspaceId: string, now: () => number = () => Date.now()): Promise<number> {
  if (!env.adaptive.enabled) return 1;
  const s = state.get(workspaceId) ?? { throttle: 1, lastDegradeAt: 0 };
  const stats = await rollingStats(workspaceId, now);

  const stressed =
    (stats.count >= 3) &&
    (stats.p95 >= env.adaptive.latencyDegradeMs || stats.errorRate >= env.adaptive.errorRateDegrade || stats.http429 > 0);

  if (stressed) {
    s.throttle = Math.max(env.adaptive.minThrottle, s.throttle * 0.5); // halve on stress
    s.lastDegradeAt = now();
  } else if (now() - s.lastDegradeAt > env.adaptive.recoverAfterMs) {
    s.throttle = Math.min(1, s.throttle + 0.1); // gradual recovery
  }
  state.set(workspaceId, s);
  return s.throttle;
}

export function resetAdaptive() {
  state.clear();
}
