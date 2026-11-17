import { describe, expect, it, vi } from "vitest";
import { clientKey, createRateLimiter, resetMissingHeaderWarning } from "@/server/http/rate-limit";

describe("createRateLimiter", () => {
  it("allows max hits per key per window, then refuses until the window passes", () => {
    const limiter = createRateLimiter({ windowMs: 1000, max: 3 });
    expect([1, 2, 3, 4].map(() => limiter.hit("a", 0))).toEqual([true, true, true, false]);
    expect(limiter.hit("b", 0)).toBe(true);
    expect(limiter.hit("a", 999)).toBe(false);
    expect(limiter.hit("a", 1000)).toBe(true);
  });

  it("never holds more than maxKeys windows and evicts the oldest, keeping recent offenders limited", () => {
    const limiter = createRateLimiter({ windowMs: 10_000, max: 1, maxKeys: 3 });
    for (const [i, k] of ["a", "b", "c"].entries()) expect(limiter.hit(k, i)).toBe(true);
    expect(limiter.hit("d", 3)).toBe(true); // evicts "a", the oldest
    expect(limiter.hit("c", 4)).toBe(false); // a recent key is still limited: the map was not cleared
    expect(limiter.hit("b", 5)).toBe(false);
    expect(limiter.hit("a", 6)).toBe(true); // the evicted key starts afresh
  });

  it("drops expired windows before evicting live ones", () => {
    const limiter = createRateLimiter({ windowMs: 100, max: 1, maxKeys: 2 });
    limiter.hit("old", 0);
    limiter.hit("live", 150);
    expect(limiter.hit("new", 160)).toBe(true); // "old" expired and goes; "live" stays
    expect(limiter.hit("live", 161)).toBe(false);
  });
});

describe("clientKey", () => {
  it("keys on the platform's address headers only, never on the client-supplied X-Forwarded-For", () => {
    const req = (headers: Record<string, string>) => new Request("http://x", { headers });
    expect(clientKey(req({ "x-vercel-forwarded-for": " 203.0.113.9 ", "x-forwarded-for": "1.2.3.4" }))).toBe("203.0.113.9");
    expect(clientKey(req({ "x-real-ip": "198.51.100.4", "x-forwarded-for": "1.2.3.4" }))).toBe("198.51.100.4");
    expect(clientKey(req({ "x-forwarded-for": "1.2.3.4, 10.0.0.1" }))).toBe("unknown");
    expect(clientKey(req({}))).toBe("unknown");
    expect(clientKey(req({ "x-real-ip": "z".repeat(100) }))).toHaveLength(64);
  });
});

describe("clientKey: trusted header, IPv6", () => {
  const req = (headers: Record<string, string>) => new Request("http://x", { headers });

  it("groups an IPv6 address by its /64 and leaves IPv4 alone", () => {
    expect(clientKey(req({ "x-real-ip": "2001:db8:1:2:aaaa:bbbb:cccc:dddd" }))).toBe("2001:db8:1:2::/64");
    expect(clientKey(req({ "x-real-ip": "2001:DB8:1:2::9" }))).toBe("2001:db8:1:2::/64");
    expect(clientKey(req({ "x-real-ip": "::1" }))).toBe("0:0:0:0::/64");
    expect(clientKey(req({ "x-real-ip": "203.0.113.9" }))).toBe("203.0.113.9");
  });

  it("reads the header named by SHARE_CLIENT_IP_HEADER first when set", () => {
    const headers = { "cf-connecting-ip": "198.51.100.7", "x-real-ip": "203.0.113.9" };
    expect(clientKey(req(headers), { SHARE_CLIENT_IP_HEADER: "CF-Connecting-IP" })).toBe("198.51.100.7");
    expect(clientKey(req(headers), {})).toBe("203.0.113.9");
    // A configured header that is absent does not fall back to a client-forgeable one.
    expect(clientKey(req({ "x-forwarded-for": "1.2.3.4" }), { SHARE_CLIENT_IP_HEADER: "cf-connecting-ip" })).toBe("unknown");
  });

  it("warns once in production when no address header is present", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      clientKey(req({}), { NODE_ENV: "production" });
      clientKey(req({}), { NODE_ENV: "production" });
      expect(warn).toHaveBeenCalledTimes(1);
      resetMissingHeaderWarning();
      clientKey(req({}), { NODE_ENV: "test" });
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
      resetMissingHeaderWarning();
    }
  });
});
