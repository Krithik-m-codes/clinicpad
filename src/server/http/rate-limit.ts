export type RateLimiter = { hit(key: string, now?: number): boolean; reset(): void };

/**
 * Fixed-window counter per key, in memory, per process (best effort: production also limits at the edge). The map
 * is bounded: past maxKeys, expired windows are dropped first and then the oldest windows are evicted one by one
 * (never the whole map, so a flood of new keys cannot reset everyone's counters).
 */
export function createRateLimiter({ windowMs, max, maxKeys = 10_000 }: { windowMs: number; max: number; maxKeys?: number }): RateLimiter {
  // A Map iterates in insertion order and a key is only ever re-inserted with a fresh window, so the first entry is the oldest.
  const windows = new Map<string, { start: number; count: number }>();
  return {
    hit(key, now = Date.now()) {
      const current = windows.get(key);
      if (!current || now - current.start >= windowMs) {
        if (current) windows.delete(key);
        else if (windows.size >= maxKeys) {
          for (const [k, w] of windows) if (now - w.start >= windowMs) windows.delete(k);
          while (windows.size >= maxKeys) {
            const oldest = windows.keys().next();
            if (oldest.done) break;
            windows.delete(oldest.value);
          }
        }
        windows.set(key, { start: now, count: 1 });
        return true;
      }
      current.count += 1;
      return current.count <= max;
    },
    reset() {
      windows.clear();
    },
  };
}

/**
 * The client address as the hosting platform reports it: X-Vercel-Forwarded-For, then X-Real-IP. The first
 * X-Forwarded-For entry is supplied by the client and is never used (it would let one client pick any bucket).
 * With no platform header the key is "unknown": every such caller shares one bucket, which fails closed.
 */
export function clientKey(request: Request): string {
  const platform = request.headers.get("x-vercel-forwarded-for")?.split(",")[0]?.trim();
  const real = request.headers.get("x-real-ip")?.trim();
  return (platform || real || "unknown").slice(0, 64);
}
