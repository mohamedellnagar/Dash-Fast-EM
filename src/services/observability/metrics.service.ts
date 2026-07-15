// Lightweight in-process metrics registry (Prometheus text exposition).
// Counters accumulate; gauges are set; a few gauges are computed on scrape from
// the DB (queue depth, workers, stale registrations). No external dependency.

type Labels = Record<string, string>;

class Metric {
  values = new Map<string, number>();
  constructor(public name: string, public help: string, public type: 'counter' | 'gauge') {}
  private key(labels?: Labels): string {
    if (!labels) return '';
    return Object.keys(labels).sort().map((k) => `${k}="${labels[k]}"`).join(',');
  }
  inc(labels?: Labels, by = 1) {
    const k = this.key(labels);
    this.values.set(k, (this.values.get(k) ?? 0) + by);
  }
  set(value: number, labels?: Labels) {
    this.values.set(this.key(labels), value);
  }
  render(): string {
    let out = `# HELP ${this.name} ${this.help}\n# TYPE ${this.name} ${this.type}\n`;
    if (this.values.size === 0) out += `${this.name} 0\n`;
    for (const [k, v] of this.values) out += k ? `${this.name}{${k}} ${v}\n` : `${this.name} ${v}\n`;
    return out;
  }
}

class Registry {
  private metrics = new Map<string, Metric>();
  private get(name: string, help: string, type: 'counter' | 'gauge'): Metric {
    let m = this.metrics.get(name);
    if (!m) {
      m = new Metric(name, help, type);
      this.metrics.set(name, m);
    }
    return m;
  }
  counter(name: string, help = name) { return this.get(name, help, 'counter'); }
  gauge(name: string, help = name) { return this.get(name, help, 'gauge'); }
  render(): string { return [...this.metrics.values()].map((m) => m.render()).join('\n'); }
}

export const registry = new Registry();

// Declared metrics (created lazily on first use).
export const metrics = {
  requestsTotal: registry.counter('fasttest_requests_total', 'FastTest API requests'),
  requestDuration: registry.gauge('fasttest_request_duration_ms', 'Last FastTest request duration (ms)'),
  errorsTotal: registry.counter('fasttest_errors_total', 'FastTest API errors by category'),
  authTotal: registry.counter('fasttest_authentication_total', 'Workspace authentications'),
  tokensRefreshed: registry.counter('fasttest_tokens_refreshed_total', 'Token refreshes'),
  jobsTotal: registry.counter('sync_jobs_total', 'Sync jobs processed by type/outcome'),
  jobsFailed: registry.counter('sync_jobs_failed_total', 'Failed sync jobs'),
  jobsRetried: registry.counter('sync_jobs_retried_total', 'Retried sync jobs'),
  jobDuration: registry.gauge('sync_job_duration_ms', 'Last sync job duration (ms)'),
  queueDepth: registry.gauge('sync_queue_depth', 'Queued sync jobs'),
  oldestJobAge: registry.gauge('sync_oldest_job_age_ms', 'Oldest queued job age (ms)'),
  activeWorkers: registry.gauge('active_workers', 'Healthy worker count'),
  staleRegistrations: registry.gauge('stale_registrations', 'Stale registration count'),
  circuitState: registry.gauge('workspace_circuit_state', 'Circuit state (0 closed,1 half,2 open) by workspace'),
};

export function renderMetrics(): string {
  return registry.render();
}
