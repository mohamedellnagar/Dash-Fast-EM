import { describe, it, expect, beforeEach } from 'vitest';
import { getCachedToken, setCachedToken, invalidateToken, clearAllTokens } from '../../src/services/fasttest/token-cache';

// Default refresh margin is 300s. TTL 3600s.
describe('Token cache', () => {
  beforeEach(() => clearAllTokens());

  it('returns null when nothing cached', () => {
    expect(getCachedToken('ws1', 1000)).toBeNull();
  });
  it('returns a fresh token before the refresh margin', () => {
    const t0 = 1_000_000;
    setCachedToken('ws1', 'tok-abc', 3600, t0);
    expect(getCachedToken('ws1', t0 + 1000 * 1000)).toBe('tok-abc'); // well within TTL
  });
  it('treats the token as expired inside the refresh margin', () => {
    const t0 = 1_000_000;
    setCachedToken('ws1', 'tok-abc', 3600, t0);
    // 3600s TTL, 300s margin → stale after 3300s
    expect(getCachedToken('ws1', t0 + 3301 * 1000)).toBeNull();
  });
  it('invalidates a specific workspace token', () => {
    const t0 = 1_000_000;
    setCachedToken('ws1', 'tok', 3600, t0);
    invalidateToken('ws1');
    expect(getCachedToken('ws1', t0 + 1000)).toBeNull();
  });
  it('isolates tokens per workspace', () => {
    const t0 = 1_000_000;
    setCachedToken('wsA', 'A', 3600, t0);
    setCachedToken('wsB', 'B', 3600, t0);
    expect(getCachedToken('wsA', t0 + 1000)).toBe('A');
    expect(getCachedToken('wsB', t0 + 1000)).toBe('B');
  });
});
