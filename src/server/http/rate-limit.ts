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

type KeyEnv = { NODE_ENV?: string; SHARE_CLIENT_IP_HEADER?: string };

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
 * The client address as the hosting platform reports it. SHARE_CLIENT_IP_HEADER names the header a self-hosted proxy
 * sets (and only that one is read then); otherwise X-Vercel-Forwarded-For, then X-Real-IP. The first X-Forwarded-For
 * entry is supplied by the client and is never used (it would let one client pick any bucket). With no such header
 * the key is "unknown": every such caller shares one bucket, which fails closed, and production logs it once because
 * it means the proxy is not configured.
 */
export function clientKey(request: Request, env: KeyEnv = process.env): string {
  const configured = env.SHARE_CLIENT_IP_HEADER?.trim();
  const names = configured ? [configured] : ["x-vercel-forwarded-for", "x-real-ip"];
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
