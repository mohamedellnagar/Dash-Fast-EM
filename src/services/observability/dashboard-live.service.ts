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
// A cached frame is only good enough to prime a new viewer while it is fresh.
// If snapshot computation has been failing, tick() keeps the last good frame —
// without this bound every new tab would silently be handed arbitrarily old
// numbers and have no way to tell.
const MAX_PRIMING_AGE_MS = 10_000;
const clients = new Set<Response>();
let timer: NodeJS.Timeout | null = null;
let lastPayload: string | null = null;
let lastPayloadAt = 0;

/** Exported for tests: the exact bundle pushed to every connected wall. */
export async function computeSnapshot() {
  // Unscoped global view — but soft-deleted registrations are still excluded,
  // exactly as buildRegistrationWhere() does for every scoped page. Without the
  // deletedAt guard the wall counted deleted rows and its totals drifted from
  // every other dashboard.
  const EMPTY = { deletedAt: null };
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
  // Exam delivery vs forms/surveys, derived from the subject rows so the wall
  // never averages a parent questionnaire into the exam completion rate.
  const byKind = dash.splitByKind(subjects.subjects);
  return { overview, subjects, byKind, grades, participation, exam, feed, today, queue, control, health, apiHealth, schools, at: Date.now() };
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
  lastPayloadAt = Date.now();
  // The heavy aggregates are memoized for 15s while the timer ticks every 2s, so
  // most frames repeat the previous one verbatim. Each frame is ~70 KB and forces
  // a re-render on every open screen — skip the ones that carry no new
  // information. (`at` is excluded from the comparison; it always differs.)
  const unchanged = lastPayload !== null && stripTimestamp(payload) === stripTimestamp(lastPayload);
  lastPayload = payload;

  // Viewers treat a gap in frames as "this screen has gone stale", so a
  // suppressed tick still has to say "I computed, nothing changed" — otherwise
  // a quiet system would raise a false alarm.
  const frame = unchanged ? `event: keepalive\ndata: ${lastPayloadAt}\n\n` : payload;
  for (const res of clients) {
    try { res.write(frame); } catch { /* dropped on next close event */ }
  }
}

/**
 * A frame's "is this news?" key.
 *
 * Three fields are recomputed from now() on every tick and would otherwise make
 * every frame unique even on a completely idle system: the snapshot's own `at`,
 * the queue's oldest-job age, and the health window's start. None of them is
 * rendered on the wall — they are derived clocks, not data — so they are
 * coarsened here rather than at the source, where other consumers (the queue
 * page, the Prometheus exporter) legitimately want live millisecond values.
 */
function stripTimestamp(frame: string): string {
  return frame
    .replace(/,"at":\d+\}/, '}')
    .replace(/"oldestQueuedAgeMs":(\d+)/, (_m, ms) => `"oldestQueuedAgeMs":${Math.floor(Number(ms) / 30_000)}`)
    .replace(/"since1h":"[^"]*"/g, '"since1h":""');
}

function ensureTimer() {
  if (!timer) timer = setInterval(() => void tick(), INTERVAL_MS);
}
function maybeStopTimer() {
  if (timer && clients.size === 0) { clearInterval(timer); timer = null; lastPayload = null; lastPayloadAt = 0; }
}

/** Subscribe an SSE response to the shared live snapshot. */
export function subscribeDashboardLive(res: Response, onClose: () => void): void {
  clients.add(res);
  ensureTimer();
  // Send the last computed frame immediately so a new viewer isn't blank until
  // the next tick; otherwise trigger a fresh compute.
  if (lastPayload && Date.now() - lastPayloadAt <= MAX_PRIMING_AGE_MS) {
    try { res.write(lastPayload); } catch { /* ignore */ }
  } else {
    void tick(); // no frame, or the cached one is too old to be trusted
  }
  const cleanup = () => {
    clients.delete(res);
    maybeStopTimer();
    onClose();
  };
  res.on('close', cleanup);
}
