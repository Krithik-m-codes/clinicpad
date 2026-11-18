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

type KeyEnv = { NODE_ENV?: string; SHARE_CLIENT_IP_HEADER?: string; VERCEL?: string };

let warnedMissingHeader = false;
/** For tests: lets the once-only "no address header" warning fire again. */
export function resetMissingHeaderWarning(): void {
  warnedMissingHeader = false;
}

/** IPv6 addresses are grouped by their /64 (one subscriber owns a whole /64, so per-address keys are free to rotate); IPv4 stays as is. */
function groupAddress(raw: string): string {
  const address = raw.split("%")[0].toLowerCase();
  if (!address.includes(":")) return address;
  const [head, tail] = address.split("::");
  const front = head === "" ? [] : head.split(":");
  const back = tail === undefined || tail === "" ? [] : tail.split(":");
  const groups = tail === undefined ? front : [...front, ...Array<string>(Math.max(0, 8 - front.length - back.length)).fill("0"), ...back];
  const first = groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "") || "0");
  while (first.length < 4) first.push("0");
  return `${first.join(":")}::/64`;
}

/**
 * The client address as the hosting platform reports it. Only the header named by SHARE_CLIENT_IP_HEADER is read
 * (the one a self-hosted proxy sets and strips from client requests); on Vercel (VERCEL is set) the platform header
 * X-Vercel-Forwarded-For is the default. X-Real-IP and the first X-Forwarded-For entry are client-supplied unless a
 * proxy overwrites them, so they are never read unless SHARE_CLIENT_IP_HEADER names one. With no trusted header the
 * key is "unknown": every such caller shares one conservative bucket per process, which fails closed, and production
 * logs it once because it means the proxy is not configured.
 */
export function clientKey(request: Request, env: KeyEnv = process.env): string {
  const configured = env.SHARE_CLIENT_IP_HEADER?.trim();
  const names = configured ? [configured] : env.VERCEL ? ["x-vercel-forwarded-for"] : [];
  for (const name of names) {
    const value = request.headers.get(name)?.split(",")[0]?.trim();
    if (value) return groupAddress(value).slice(0, 64);
  }
  if (env.NODE_ENV === "production" && !warnedMissingHeader) {
    warnedMissingHeader = true;
    console.warn("[share] no client address header on a public request: all such callers share one rate-limit bucket (set SHARE_CLIENT_IP_HEADER)");
  }
  return "unknown";
}
