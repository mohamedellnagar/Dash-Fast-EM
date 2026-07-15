import { describe, it, expect } from 'vitest';
import { TokenBucket, RateConfig, endpointConcurrency } from '../../src/services/sync/rate-limiter.service';

const cfg: RateConfig = {
  maxRps: 2, maxRpm: 5, maxConcurrent: 3, maxBatch: 25, minDelayMs: 100, burst: 2, cooldownMs: 30000,
  statusMaxConcurrent: 5,
};

describe('Token bucket rate limiting', () => {
  it('allows up to burst immediately then enforces min-delay', () => {
    const t0 = 1_000_000;
    const b = new TokenBucket(cfg, t0);
    expect(b.tryAcquire(t0).allowed).toBe(true); // 1st (burst)
    // immediate 2nd blocked by min-delay
    expect(b.tryAcquire(t0).allowed).toBe(false);
    // after min-delay, allowed again (still have burst token)
    expect(b.tryAcquire(t0 + 100).allowed).toBe(true);
  });

  it('enforces the per-minute cap', () => {
    let t = 1_000_000;
    const b = new TokenBucket({ ...cfg, minDelayMs: 0, burst: 100, maxRps: 100 }, t);
    let allowed = 0;
    for (let i = 0; i < 10; i++) {
      if (b.tryAcquire(t).allowed) allowed++;
      t += 10;
    }
    expect(allowed).toBe(cfg.maxRpm); // capped at 5/min
  });

  it('adaptive throttle scales the effective rate down', () => {
    let t = 1_000_000;
    const b = new TokenBucket({ ...cfg, minDelayMs: 0, burst: 100 }, t);
    // throttle 0.2 → rpm floor(5*0.2)=1
    let allowed = 0;
    for (let i = 0; i < 10; i++) {
      if (b.tryAcquire(t, 0.2).allowed) allowed++;
      t += 10;
    }
    expect(allowed).toBe(1);
  });

  it('resolves per-endpoint concurrency overrides', () => {
    expect(endpointConcurrency(cfg, 'status')).toBe(5);
    expect(endpointConcurrency(cfg, 'results')).toBe(3); // inherits maxConcurrent
  });
});
