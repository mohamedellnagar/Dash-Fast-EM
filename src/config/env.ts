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

  databaseUrl: str('DATABASE_URL', 'file:./dev.db'),

  encryptionKey: str('ENCRYPTION_KEY', 'dev-insecure-key-please-change-000000000000000000000000000000000000'),
  sessionSecret: str('SESSION_SECRET', 'dev-insecure-session-secret'),
  sessionSecureCookie: bool('SESSION_SECURE_COOKIE', false),
  sessionMaxAgeMs: int('SESSION_MAX_AGE_MS', 3600000),

  bootstrapAdminEmail: str('BOOTSTRAP_ADMIN_EMAIL', 'admin@fasttest.local'),
  bootstrapAdminPassword: str('BOOTSTRAP_ADMIN_PASSWORD', 'ChangeMe!Admin123'),

  fasttest: {
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
    concurrency: int('SYNC_WORKER_CONCURRENCY', 4),
    tickIntervalMs: int('SYNC_TICK_INTERVAL_MS', 15000),
    maxBatch: int('SYNC_MAX_BATCH', 50),
    rateLimitPerMinute: int('FASTTEST_RATE_LIMIT_PER_MINUTE', 120),
    maxRetries: int('SYNC_MAX_RETRIES', 3),
    schedulerEnabled: bool('SCHEDULER_ENABLED', true),
    schedulerIntervalMs: int('SCHEDULER_INTERVAL_MS', 30000),
    jobLockTtlMs: int('SYNC_JOB_LOCK_TTL_MS', 60000),
    stalledJobMs: int('SYNC_STALLED_JOB_MS', 120000),
    heartbeatMs: int('WORKER_HEARTBEAT_MS', 10000),
    workerStaleMs: int('WORKER_STALE_MS', 30000),
    globalMaxConcurrent: int('SYNC_GLOBAL_MAX_CONCURRENT', 16),
  },

  // Conservative per-workspace defaults — FastTest limits are NOT assumed.
  rate: {
    maxRps: num('RATE_MAX_RPS', 2),
    maxRpm: int('RATE_MAX_RPM', 60),
    maxConcurrent: int('RATE_MAX_CONCURRENT', 3),
    minDelayMs: int('RATE_MIN_DELAY_MS', 200),
    burst: int('RATE_BURST', 5),
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
