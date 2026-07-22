import { prisma } from '../../db/prisma';
import { logger } from '../../lib/logger';
import { rollingStats } from './adaptive.service';
import { invalidateRateConfig } from './rate-limiter.service';
import { isFastMode } from './queue.service';

/**
 * Auto-tune per-workspace throughput with AIMD (additive-increase /
 * multiplicative-decrease — the same principle TCP uses to find a link's
 * capacity). While the workspace is healthy we nudge maxRpm up toward the
 * mode's ceiling; the moment FastTest pushes back (429s, errors, or latency
 * spikes) we cut it hard. Over a few minutes maxRpm settles just under what
 * FastTest tolerates — no manual guessing.
 *
 * The single knob an operator touches is the Mode (Normal vs FAST): it sets the
 * ceiling and how aggressively we climb. Everything else — rpm, concurrency,
 * rps, min-delay — is derived and self-managed per workspace.
 */

const FLOOR_RPM = 30;      // never tune below this
const MIN_SAMPLES = 20;    // need this many requests in the window to judge
// Health thresholds — stay well clear of FastTest pushback.
const MAX_P95_MS = 3000;
const MAX_ERROR_RATE = 0.05;

// Per-mode tuning envelope. FAST reaches for a high ceiling and climbs quickly;
// NORMAL stays conservative. Backoff on stress is always aggressive (halve).
// FAST climbs aggressively (reaches its ceiling from a 600 seed in ~5 ticks
// instead of ~20) so recovering after a mode change isn't a 10-minute crawl.
// Backoff on real stress is still an immediate halving, so overshooting is safe.
const MODE_TUNING = {
  NORMAL: { ceil: 600, increase: 60 },
  FAST: { ceil: 3000, increase: 500 },
};

export async function autoTuneRateLimits(now: () => number = () => Date.now()): Promise<void> {
  const rows = await prisma.workspaceRateLimit.findMany({ where: { autoTune: true } });
  if (!rows.length) return;
  const tuning = (await isFastMode().catch(() => false)) ? MODE_TUNING.FAST : MODE_TUNING.NORMAL;
  for (const row of rows) {
    try {
      const s = await rollingStats(row.workspaceId, now);

      const stressed = s.http429 > 0 || s.errorRate >= MAX_ERROR_RATE || s.p95 >= MAX_P95_MS;
      let next = row.maxRpm;
      if (stressed) {
        next = Math.max(FLOOR_RPM, Math.floor(row.maxRpm * 0.5));
      } else if (row.maxRpm > tuning.ceil) {
        // Mode was lowered (FAST → NORMAL): ease down toward the new ceiling.
        next = Math.max(tuning.ceil, Math.floor(row.maxRpm * 0.7));
      } else if (s.count < MIN_SAMPLES) {
        // Not enough traffic to prove health — hold, but still fix stale
        // derived limits below.
        next = row.maxRpm;
      } else {
        next = Math.min(tuning.ceil, row.maxRpm + tuning.increase);
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
