import { Router } from 'express';
import { env } from '../config/env';
import { prisma } from '../db/prisma';
import { metrics, renderMetrics } from '../services/observability/metrics.service';
import { queueStats } from '../services/sync/queue.service';
import { activeWorkerCount } from '../services/sync/worker-registry.service';

export const metricsRouter = Router();

// Prometheus-style metrics. Secured by METRICS_TOKEN when set (bearer or ?token).
// Never emits secrets — only counters/gauges.
metricsRouter.get('/metrics', async (req, res) => {
  if (env.metricsToken) {
    const bearer = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    const token = bearer || (req.query.token as string) || '';
    if (token !== env.metricsToken) return res.status(401).type('text/plain').send('unauthorized');
  }
  // Refresh live gauges on scrape.
  const [stats, workers, stale] = await Promise.all([
    queueStats(),
    activeWorkerCount(),
    prisma.examRegistration.count({ where: { isStale: true, deletedAt: null } }),
  ]);
  metrics.queueDepth.set(stats.queued);
  metrics.oldestJobAge.set(stats.oldestQueuedAgeMs);
  metrics.activeWorkers.set(workers);
  metrics.staleRegistrations.set(stale);

  res.type('text/plain; version=0.0.4').send(renderMetrics());
});
