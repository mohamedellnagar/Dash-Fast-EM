import { prisma } from '../../db/prisma';
import { env } from '../../config/env';

// Per-workspace rate limiting. Concurrency is enforced distributed-safely at
// job-claim time (counting RUNNING jobs per workspace in the DB). Request pace
// (rps / rpm / min-delay / burst) is enforced by an in-process token bucket per
// worker with CONSERVATIVE defaults — FastTest's real limits are unknown, so we
// never assume them. Values are configurable per workspace (WorkspaceRateLimit)
// with system defaults from env.

export type Endpoint = 'auth' | 'status' | 'results' | 'other';

export interface RateConfig {
  maxRps: number;
  maxRpm: number;
  maxConcurrent: number;
  maxBatch: number;
  minDelayMs: number;
  burst: number;
  cooldownMs: number;
  authMaxConcurrent?: number | null;
  statusMaxConcurrent?: number | null;
  resultsMaxConcurrent?: number | null;
}

export function defaultRateConfig(): RateConfig {
  return {
    maxRps: env.rate.maxRps,
    maxRpm: env.rate.maxRpm,
    maxConcurrent: env.rate.maxConcurrent,
    maxBatch: env.sync.maxBatch,
    minDelayMs: env.rate.minDelayMs,
    burst: env.rate.burst,
    cooldownMs: env.rate.cooldownMs,
  };
}

const configCache = new Map<string, { cfg: RateConfig; at: number }>();
const CONFIG_TTL_MS = 15000;

export async function getRateConfig(workspaceId: string, now: () => number = () => Date.now()): Promise<RateConfig> {
  const cached = configCache.get(workspaceId);
  if (cached && now() - cached.at < CONFIG_TTL_MS) return cached.cfg;
  const row = await prisma.workspaceRateLimit.findUnique({ where: { workspaceId } }).catch(() => null);
  const d = defaultRateConfig();
  const cfg: RateConfig = row
    ? {
        maxRps: row.maxRps, maxRpm: row.maxRpm, maxConcurrent: row.maxConcurrent, maxBatch: row.maxBatch,
        minDelayMs: row.minDelayMs, burst: row.burst, cooldownMs: row.cooldownMs,
        authMaxConcurrent: row.authMaxConcurrent, statusMaxConcurrent: row.statusMaxConcurrent, resultsMaxConcurrent: row.resultsMaxConcurrent,
      }
    : d;
  configCache.set(workspaceId, { cfg, at: now() });
  return cfg;
}

export function invalidateRateConfig(workspaceId?: string) {
  if (workspaceId) configCache.delete(workspaceId);
  else configCache.clear();
}

export function endpointConcurrency(cfg: RateConfig, ep: Endpoint): number {
  if (ep === 'auth' && cfg.authMaxConcurrent != null) return cfg.authMaxConcurrent;
  if (ep === 'status' && cfg.statusMaxConcurrent != null) return cfg.statusMaxConcurrent;
  if (ep === 'results' && cfg.resultsMaxConcurrent != null) return cfg.resultsMaxConcurrent;
  return cfg.maxConcurrent;
}

// Token bucket + fixed-minute window + minimum-spacing per workspace.
export class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  private windowStart: number;
  private windowCount = 0;
  private lastGrant = 0;

  constructor(private cfg: RateConfig, now: number) {
    this.tokens = cfg.burst;
    this.lastRefill = now;
    this.windowStart = now;
  }

  /** Adaptive multiplier ∈ (0,1] scales effective rps/rpm down under stress. */
  tryAcquire(now: number, throttle = 1): { allowed: boolean; retryAfterMs: number } {
    const rps = Math.max(0.1, this.cfg.maxRps * throttle);
    const rpm = Math.max(1, Math.floor(this.cfg.maxRpm * throttle));
    const minDelay = this.cfg.minDelayMs / Math.max(throttle, 0.1);

    // Refill token bucket by rps.
    const elapsed = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.cfg.burst, this.tokens + elapsed * rps);
    this.lastRefill = now;

    // Reset minute window.
    if (now - this.windowStart >= 60000) {
      this.windowStart = now;
      this.windowCount = 0;
    }

    if (now - this.lastGrant < minDelay) return { allowed: false, retryAfterMs: Math.ceil(minDelay - (now - this.lastGrant)) };
    if (this.windowCount >= rpm) return { allowed: false, retryAfterMs: 60000 - (now - this.windowStart) };
    if (this.tokens < 1) return { allowed: false, retryAfterMs: Math.ceil((1 - this.tokens) / rps * 1000) };

    this.tokens -= 1;
    this.windowCount += 1;
    this.lastGrant = now;
    return { allowed: true, retryAfterMs: 0 };
  }
}

const buckets = new Map<string, TokenBucket>();

export async function acquireSlot(workspaceId: string, throttle = 1, now: () => number = () => Date.now()): Promise<{ allowed: boolean; retryAfterMs: number }> {
  const cfg = await getRateConfig(workspaceId, now);
  let b = buckets.get(workspaceId);
  if (!b) {
    b = new TokenBucket(cfg, now());
    buckets.set(workspaceId, b);
  }
  return b.tryAcquire(now(), throttle);
}

export function resetBuckets() {
  buckets.clear();
}

/** Distributed per-workspace concurrency: count RUNNING jobs for the workspace. */
export async function currentWorkspaceConcurrency(workspaceId: string): Promise<number> {
  return prisma.syncJob.count({ where: { workspaceId, status: 'RUNNING' } });
}
