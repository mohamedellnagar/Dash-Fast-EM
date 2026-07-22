import { prisma } from '../../db/prisma';
import { logger } from '../../lib/logger';
import { rollingStats } from './adaptive.service';
import { invalidateRateConfig } from './rate-limiter.service';

/**
 * Auto-tune per-workspace throughput with AIMD (additive-increase /
 * multiplicative-decrease — the same principle TCP uses to find a link's
 * capacity). While the workspace is healthy we nudge maxRpm up to discover the
 * ceiling; the moment FastTest pushes back (429s, errors, or latency spikes) we
 * cut it hard. Over a few minutes maxRpm settles just under what FastTest
 * tolerates — no manual guessing.
 *
 * Only workspaces with rateLimit.autoTune = true are touched. maxRpm on that
 * row holds the current tuned value; maxConcurrent tracks it loosely.
 */

const FLOOR_RPM = 30;      // never tune below this
const CEIL_RPM = 3000;     // hard safety cap
const INCREASE = 30;       // additive step up per healthy tick (rpm)
const DECREASE = 0.5;      // multiplicative cut on stress
const MIN_SAMPLES = 20;    // need this many requests in the window to judge
// Health thresholds — stay well clear of FastTest pushback.
const MAX_P95_MS = 3000;
const MAX_ERROR_RATE = 0.05;

export async function autoTuneRateLimits(now: () => number = () => Date.now()): Promise<void> {
  const rows = await prisma.workspaceRateLimit.findMany({ where: { autoTune: true } });
  for (const row of rows) {
    try {
      const s = await rollingStats(row.workspaceId, now);
      // Not enough traffic yet to make a decision — hold steady.
      if (s.count < MIN_SAMPLES) continue;

      const stressed = s.http429 > 0 || s.errorRate >= MAX_ERROR_RATE || s.p95 >= MAX_P95_MS;
      let next = row.maxRpm;
      if (stressed) {
        next = Math.max(FLOOR_RPM, Math.floor(row.maxRpm * DECREASE));
      } else {
        next = Math.min(CEIL_RPM, row.maxRpm + INCREASE);
      }

      // Derive the companion limits so rpm is always the binding constraint —
      // otherwise a stale minDelayMs (e.g. 200ms → 5/s) silently caps throughput
      // far below the tuned rpm.
      const nextConc = Math.max(3, Math.min(48, Math.ceil(next / 60)));
      const nextRps = Math.max(1, Math.ceil(next / 30));
      const nextDelay = Math.max(5, Math.floor(60000 / next)); // ms between requests

      // Skip only when NOTHING changes — including when rpm is pinned at the
      // ceiling but the derived limits are still stale (the bug that pinned a
      // 3000-rpm workspace at 200ms min-delay).
      if (next === row.maxRpm && nextConc === row.maxConcurrent && nextRps === row.maxRps && nextDelay === row.minDelayMs) continue;

      await prisma.workspaceRateLimit.update({
        where: { workspaceId: row.workspaceId },
        data: { maxRpm: next, maxConcurrent: nextConc, maxRps: nextRps, minDelayMs: nextDelay },
      });
      invalidateRateConfig(row.workspaceId);
      logger.info(
        { workspaceId: row.workspaceId, from: row.maxRpm, to: next, minDelayMs: nextDelay, stressed, p95: s.p95, errorRate: s.errorRate, http429: s.http429 },
        'autotune adjusted workspace limits',
      );
    } catch (e) {
      logger.warn({ workspaceId: row.workspaceId, err: (e as Error).message }, 'autotune failed for workspace');
    }
  }
}
