// In-memory per-workspace token cache. Tokens are cached only in the backend
// process and never exposed to clients. A token is considered stale before its
// true expiry by a configurable refresh margin so callers refresh proactively.
import { env } from '../../config/env';

interface CachedToken {
  token: string;
  expiresAtMs: number; // absolute expiry
}

const cache = new Map<string, CachedToken>();

export function getCachedToken(workspaceId: string, nowMs: number): string | null {
  const entry = cache.get(workspaceId);
  if (!entry) return null;
  const marginMs = env.fasttest.tokenRefreshMarginSeconds * 1000;
  if (nowMs >= entry.expiresAtMs - marginMs) return null; // treat as expired
  return entry.token;
}

export function setCachedToken(workspaceId: string, token: string, ttlSeconds: number, nowMs: number): void {
  cache.set(workspaceId, { token, expiresAtMs: nowMs + ttlSeconds * 1000 });
}

export function invalidateToken(workspaceId: string): void {
  cache.delete(workspaceId);
}

export function clearAllTokens(): void {
  cache.clear();
}
