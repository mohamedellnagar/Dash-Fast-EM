import dotenv from 'dotenv';

dotenv.config();

function str(key: string, fallback?: string): string {
  const v = process.env[key];
  if (v === undefined || v === '') {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return v;
}

function int(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (Number.isNaN(n)) throw new Error(`Environment variable ${key} must be a number`);
  return n;
}

function num(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (Number.isNaN(n)) throw new Error(`Environment variable ${key} must be a number`);
  return n;
}

function bool(key: string, fallback: boolean): boolean {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

export const env = {
  nodeEnv: str('NODE_ENV', 'development'),
  isProd: str('NODE_ENV', 'development') === 'production',
  port: int('PORT', 3000),
  logLevel: str('LOG_LEVEL', 'info'),
  // IANA timezone the daily sync window is evaluated in. Defaults to UAE so the
  // window matches local operating hours regardless of the server's clock (which
  // is UTC in most containers).
  timezone: str('SYNC_TZ', 'Asia/Dubai'),
  // IANA zone every exam timestamp is RENDERED in for operators.
  displayTimezone: str('DISPLAY_TZ', 'Asia/Dubai'),

  databaseUrl: str('DATABASE_URL', 'file:./dev.db'),

  encryptionKey: str('ENCRYPTION_KEY', 'dev-insecure-key-please-change-000000000000000000000000000000000000'),
  sessionSecret: str('SESSION_SECRET', 'dev-insecure-session-secret'),
  sessionSecureCookie: bool('SESSION_SECURE_COOKIE', false),
  sessionMaxAgeMs: int('SESSION_MAX_AGE_MS', 3600000),

  bootstrapAdminEmail: str('BOOTSTRAP_ADMIN_EMAIL', 'admin@fasttest.local'),
  bootstrapAdminPassword: str('BOOTSTRAP_ADMIN_PASSWORD', 'ChangeMe!Admin123'),

  fasttest: {
    // IANA zone FastTest's own clock runs in. Their API returns naive strings
    // with no offset, so this is the only way to place them on a timeline.
    // Confirmed as US Central against 71,589 stored payloads; it must be an
    // IANA name (not a fixed offset) because the US observes DST and the UAE
    // does not, so the gap is +9h in summer and +10h in winter.
    sourceTimezone: str('FASTTEST_SOURCE_TZ', 'America/Chicago'),
    baseUrl: str('FASTTEST_BASE_URL', 'https://uae.fasttestweb.com/FastTest/api'),
    username: str('FASTTEST_AUTH_USERNAME', ''),
    password: str('FASTTEST_AUTH_PASSWORD', ''),
    tokenTtlSeconds: int('FASTTEST_TOKEN_TTL_SECONDS', 3600),
    tokenRefreshMarginSeconds: int('FASTTEST_TOKEN_REFRESH_MARGIN_SECONDS', 300),
    requestTimeoutMs: int('FASTTEST_REQUEST_TIMEOUT_MS', 15000),
    keys: {
      ARABIC: process.env.FASTTEST_KEY_ARABIC || '',
      ENGLISH: process.env.FASTTEST_KEY_ENGLISH || '',
      MATH: process.env.FASTTEST_KEY_MATH || '',
      SCIENCE: process.env.FASTTEST_KEY_SCIENCE || '',
    } as Record<string, string>,
  },

  sync: {
    enabled: bool('SYNC_ENABLED', true),
    concurrency: int('SYNC_WORKER_CONCURRENCY', 20),
    tickIntervalMs: int('SYNC_TICK_INTERVAL_MS', 15000),
    maxBatch: int('SYNC_MAX_BATCH', 50),
    rateLimitPerMinute: int('FASTTEST_RATE_LIMIT_PER_MINUTE', 300),
    maxRetries: int('SYNC_MAX_RETRIES', 3),
    schedulerEnabled: bool('SCHEDULER_ENABLED', true),
    // Top up the queue every 10s (was 30s): with a fast worker a 30s gap let the
    // queue drain to empty between ticks, so throughput sawtoothed (spikes then
    // 0). More frequent, deduped top-ups keep it steadily fed.
    schedulerIntervalMs: int('SCHEDULER_INTERVAL_MS', 10000),
    jobLockTtlMs: int('SYNC_JOB_LOCK_TTL_MS', 60000),
    stalledJobMs: int('SYNC_STALLED_JOB_MS', 120000),
    heartbeatMs: int('WORKER_HEARTBEAT_MS', 10000),
    workerStaleMs: int('WORKER_STALE_MS', 30000),
    globalMaxConcurrent: int('SYNC_GLOBAL_MAX_CONCURRENT', 60),
    // Run the sync worker loops inside the web process instead of a separate
    // process. Convenient for single-box / local runs (one `npm run dev` does
    // everything). In production with a dedicated worker service, keep this off.
    workerInWeb: bool('WORKER_IN_WEB', false),
  },

  // Per-workspace defaults. Moderate out of the box (auto-tune discovers the
  // real ceiling from live FastTest health); overridable per-workspace in the UI.
  rate: {
    maxRps: num('RATE_MAX_RPS', 8),
    maxRpm: int('RATE_MAX_RPM', 300),
    maxConcurrent: int('RATE_MAX_CONCURRENT', 10),
    minDelayMs: int('RATE_MIN_DELAY_MS', 50),
    burst: int('RATE_BURST', 15),
    cooldownMs: int('RATE_COOLDOWN_MS', 30000),
  },

  // Adaptive throttling thresholds.
  adaptive: {
    enabled: bool('ADAPTIVE_ENABLED', true),
    latencyDegradeMs: int('ADAPTIVE_LATENCY_MS', 4000),
    errorRateDegrade: num('ADAPTIVE_ERROR_RATE', 0.2),
    recoverAfterMs: int('ADAPTIVE_RECOVER_MS', 60000),
    minThrottle: num('ADAPTIVE_MIN_THROTTLE', 0.25),
  },

  // Circuit breaker thresholds.
  circuit: {
    failureThreshold: int('CIRCUIT_FAILURE_THRESHOLD', 5),
    timeoutThreshold: int('CIRCUIT_TIMEOUT_THRESHOLD', 3),
    authFailThreshold: int('CIRCUIT_AUTH_THRESHOLD', 3),
    openMs: int('CIRCUIT_OPEN_MS', 60000),
    halfOpenProbes: int('CIRCUIT_HALFOPEN_PROBES', 2),
  },

  // Retention (days). Active incidents/unresolved alerts are never deleted.
  retention: {
    apiLogsDays: int('RETENTION_API_LOGS_DAYS', 90),
    completedJobsDays: int('RETENTION_COMPLETED_JOBS_DAYS', 30),
    failedJobsDays: int('RETENTION_FAILED_JOBS_DAYS', 180),
    heartbeatDays: int('RETENTION_HEARTBEAT_DAYS', 30),
    metricsDays: int('RETENTION_METRICS_DAYS', 90),
    auditDays: int('RETENTION_AUDIT_DAYS', 365),
  },

  metricsToken: process.env.METRICS_TOKEN || '',

  loadTestEnabled: bool('LOAD_TEST_ENABLED', false),
};

export type Env = typeof env;
