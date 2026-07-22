import type { Response } from 'express';
import { logger } from '../../lib/logger';
import * as dash from '../dashboard.service';
import { queueStats, getSyncControlState } from '../sync/queue.service';
import { getFastTestHealth } from './fasttest-health.service';

/**
 * Shared live-dashboard broadcaster.
 *
 * The Live Overview wall needs ~11 aggregate queries refreshed continuously.
 * Having every open browser poll them independently multiplied DB load by the
 * number of viewers. Instead, compute ONE global snapshot on a single timer and
 * fan it out to all connected SSE clients — so ten screens cost the same as one.
 *
 * The timer only runs while at least one client is connected. The snapshot is
 * the unfiltered global view (no per-workspace scoping), which is exactly what
 * the operations wall shows.
 */

const INTERVAL_MS = 2000;
const clients = new Set<Response>();
let timer: NodeJS.Timeout | null = null;
let lastPayload: string | null = null;

async function computeSnapshot() {
  const EMPTY = {}; // unscoped global view
  const [overview, subjects, grades, participation, exam, feed, today, queue, control, health, apiHealth, schools] = await Promise.all([
    dash.overview(EMPTY),
    dash.subjectsSummary(EMPTY).then((subjects) => ({ subjects })),
    dash.completionByGrade(EMPTY).then((grades) => ({ grades })),
    dash.participationCoverage().catch(() => null),
    dash.examOperationalAnalytics().catch(() => null),
    dash.recentSyncActivity(EMPTY, 40).then((items) => ({ items })).catch(() => ({ items: [] })),
    dash.todaysActivity(EMPTY).catch(() => null),
    queueStats().catch(() => null),
    getSyncControlState().catch(() => null),
    getFastTestHealth().catch(() => null),
    dash.apiHealth().catch(() => null),
    dash.schoolsSummary(EMPTY).then((schools) => ({ schools })).catch(() => ({ schools: [] })),
  ]);
  return { overview, subjects, grades, participation, exam, feed, today, queue, control, health, apiHealth, schools, at: Date.now() };
}

async function tick() {
  if (clients.size === 0) return;
  let payload: string;
  try {
    payload = `data: ${JSON.stringify(await computeSnapshot())}\n\n`;
  } catch (e) {
    logger.warn({ err: (e as Error).message }, 'dashboard-live snapshot failed');
    return; // keep last good frame; clients retain their previous view
  }
  lastPayload = payload;
  for (const res of clients) {
    try { res.write(payload); } catch { /* dropped on next close event */ }
  }
}

function ensureTimer() {
  if (!timer) timer = setInterval(() => void tick(), INTERVAL_MS);
}
function maybeStopTimer() {
  if (timer && clients.size === 0) { clearInterval(timer); timer = null; lastPayload = null; }
}

/** Subscribe an SSE response to the shared live snapshot. */
export function subscribeDashboardLive(res: Response, onClose: () => void): void {
  clients.add(res);
  ensureTimer();
  // Send the last computed frame immediately so a new viewer isn't blank until
  // the next tick; otherwise trigger a fresh compute.
  if (lastPayload) { try { res.write(lastPayload); } catch { /* ignore */ } }
  else void tick();
  const cleanup = () => {
    clients.delete(res);
    maybeStopTimer();
    onClose();
  };
  res.on('close', cleanup);
}
