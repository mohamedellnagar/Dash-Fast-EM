// Simple in-process TTL cache for expensive read-mostly operational data
// (dashboard analytics, queue KPIs, API/workspace health). Never caches
// secrets. Every entry carries a computedAt timestamp so callers can display
// freshness and never serve stale operational data silently.

interface Entry<T> {
  value: T;
  computedAt: number;
  expiresAt: number;
}

const store = new Map<string, Entry<unknown>>();

export interface Cached<T> {
  value: T;
  computedAt: number;
  ageMs: number;
  fromCache: boolean;
}

export async function cached<T>(key: string, ttlMs: number, compute: () => Promise<T>, now: () => number = () => Date.now()): Promise<Cached<T>> {
  const t = now();
  const hit = store.get(key) as Entry<T> | undefined;
  if (hit && t < hit.expiresAt) {
    return { value: hit.value, computedAt: hit.computedAt, ageMs: t - hit.computedAt, fromCache: true };
  }
  const value = await compute();
  store.set(key, { value, computedAt: t, expiresAt: t + ttlMs });
  return { value, computedAt: t, ageMs: 0, fromCache: false };
}

/** Invalidate a specific key, a prefix, or (no arg) everything. */
export function invalidate(prefix?: string): void {
  if (!prefix) {
    store.clear();
    return;
  }
  for (const key of store.keys()) if (key.startsWith(prefix)) store.delete(key);
}

export const CACHE_KEYS = {
  ANALYTICS: 'analytics:',
  QUEUE_KPI: 'queue:kpi',
  API_HEALTH: 'api:health',
};
