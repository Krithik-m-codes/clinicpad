// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { adminDb } from "@/server/db/admin";
import { auditEvents, clinics, shareLinks } from "@/server/db/schema";
import { revokeShareLink } from "@/server/services/share-links";
import { createRateLimiter } from "@/server/http/rate-limit";
import { handleShareGet, handleSharePost, type ShareRouteDeps } from "@/server/http/share-route";
import { GET, HEAD } from "@/app/s/[token]/route";
import { createLimiter } from "@/server/pdf/limiter";
import { createFakePdfEngine } from "../helpers/fake-pdf-engine";
import { linkFor, shareablePrescription } from "../helpers/share";
import { createTestTenant, type TestTenant } from "../helpers/tenant";

let A: TestTenant;
const engine = createFakePdfEngine(1);
const PATIENT = "Route Patient आशा";
let deps: ShareRouteDeps;
const DAY = 86_400_000;

const url = (token: string) => `http://localhost:3000/s/${encodeURIComponent(token)}`;
const get = (token: string, headers: Record<string, string> = {}, extra: Partial<ShareRouteDeps> = {}) =>
  handleShareGet(new Request(url(token), { headers }), token, { ...deps, ...extra });
const post = (token: string, headers: Record<string, string> = {}, extra: Partial<ShareRouteDeps> = {}) =>
  handleSharePost(new Request(url(token), { method: "POST", headers }), token, { ...deps, ...extra });
const opens = async (linkId: string) => (await adminDb.select().from(shareLinks).where(eq(shareLinks.id, linkId)))[0].openCount;
const headerMap = (res: Response) => Object.fromEntries([...res.headers.entries()].filter(([k]) => k !== "date"));

beforeAll(async () => {
  // The platform header X-Vercel-Forwarded-For is trusted only on Vercel; X-Real-IP only when SHARE_CLIENT_IP_HEADER names it.
  vi.stubEnv("VERCEL", "1");
  A = await createTestTenant("route");
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await A.cleanup();
});

beforeEach(() => {
  engine.failWith = null;
  deps = { limiter: createRateLimiter({ windowMs: 60_000, max: 1000 }), tokenLimiter: createRateLimiter({ windowMs: 60_000, max: 1000 }), engine, pdfLimiter: createLimiter({ concurrency: 2, maxQueue: 5 }) };
});

describe("GET /s/<token>", () => {
  it("shows an interstitial with no patient or clinic details, safe headers, and a POST button; it counts nothing", async () => {
    const s = await shareablePrescription(A, PATIENT);
    const link = await linkFor(A, s.prescriptionId);
    const res = await get(link.token);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store, private, max-age=0");
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow, noarchive");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    const body = await res.text();
    expect(body).toContain('<form method="post">');
    expect(body).toContain("Open prescription (PDF)");
    expect(body).toContain('<meta name="robots" content="noindex, nofollow">');
    expect(body).not.toContain("Route Patient");
    expect(body).not.toContain("Test clinic");
    expect(await opens(link.linkId)).toBe(0);
  });

  it.each([
    ["WhatsApp's link preview", "WhatsApp/2.23.20.0 A"],
    ["Facebook's crawler", "facebookexternalhit/1.1"],
    ["Slack's unfurler", "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)"],
    ["a mail link scanner", "Mozilla/5.0 (compatible; MSIE 10.0) SafeLinks"],
  ])("gives %s the interstitial only: no open counted, no PDF rendered, nothing audited", async (_who, agent) => {
    const s = await shareablePrescription(A, PATIENT);
    const link = await linkFor(A, s.prescriptionId);
    const calls = engine.calls.length;
    const res = await get(link.token, { "user-agent": agent });
    expect(res.status).toBe(200);
    expect(await opens(link.linkId)).toBe(0);
    expect(engine.calls.length).toBe(calls);
    const events = await adminDb.select().from(auditEvents).where(eq(auditEvents.action, "prescription.share_opened"));
    expect(events.filter((e) => (e.after as { linkId?: string } | null)?.linkId === link.linkId)).toHaveLength(0);
  });

  it("answers the same 404 (status, body, headers) for every unusable link", async () => {
    const s = await shareablePrescription(A, PATIENT);
    const expired = await linkFor(A, s.prescriptionId);
    const revoked = await linkFor(A, s.prescriptionId);
    await revokeShareLink(A.as("owner"), revoked.linkId);
    const usedUp = await linkFor(A, s.prescriptionId);
    await adminDb.update(shareLinks).set({ openCount: 1 }).where(eq(shareLinks.id, usedUp.linkId));
    for (let i = 2; i <= 10; i += 1) await adminDb.update(shareLinks).set({ openCount: i }).where(eq(shareLinks.id, usedUp.linkId));

    const answers = [
      await get("short"),
      await get("a".repeat(43)),
      await get(`${"a".repeat(41)}%2F`),
      await get(expired.token, {}, { now: () => new Date(Date.now() + 8 * DAY) }),
      await get(revoked.token),
      await get(usedUp.token),
    ];
    await adminDb.update(clinics).set({ sharingEnabled: false }).where(eq(clinics.tenantId, A.tenantId));
    answers.push(await get(expired.token));
    await adminDb.update(clinics).set({ sharingEnabled: true }).where(eq(clinics.tenantId, A.tenantId));

    const bodies = await Promise.all(answers.map((r) => r.clone().text()));
    expect(answers.every((r) => r.status === 404)).toBe(true);
    expect(new Set(bodies).size).toBe(1);
    expect(bodies[0]).toContain("This link is not valid");
    const headers = answers.map((r) => JSON.stringify(headerMap(r)));
    expect(new Set(headers).size).toBe(1);
  });

  it("is wired at /s/[token], and HEAD is refused", async () => {
    const res = await GET(new Request(url("short")), { params: Promise.resolve({ token: "short" }) });
    expect(res.status).toBe(404);
    const head = HEAD();
    expect(head.status).toBe(405);
    expect(head.headers.get("allow")).toBe("GET, POST");
  });

  it("refuses a burst from one address (429), separately from other addresses", async () => {
    const tight = createRateLimiter({ windowMs: 60_000, max: 2 });
    const from = (ip: string) => get("short", { "x-vercel-forwarded-for": ip }, { limiter: tight });
    expect((await from("203.0.113.1")).status).toBe(404);
    expect((await from("203.0.113.1")).status).toBe(404);
    expect((await from("203.0.113.1")).status).toBe(429);
    expect((await from("203.0.113.2")).status).toBe(404);
    // A client-chosen X-Forwarded-For never picks its bucket.
    const spoofed = (n: number) => get("short", { "x-vercel-forwarded-for": "203.0.113.9", "x-forwarded-for": `198.51.100.${n}` }, { limiter: tight });
    expect([(await spoofed(1)).status, (await spoofed(2)).status, (await spoofed(3)).status]).toEqual([404, 404, 429]);
  });
});

describe("POST /s/<token>", () => {
  it("serves the PDF inline with no-store and noindex, and counts one open", async () => {
    const s = await shareablePrescription(A, PATIENT);
    const link = await linkFor(A, s.prescriptionId);
    const res = await post(link.token, { "sec-fetch-site": "same-origin" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toMatch(/^inline; filename="Rx-\d+-v1\.pdf"$/);
    expect(res.headers.get("cache-control")).toBe("no-store, private, max-age=0");
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow, noarchive");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(String.fromCharCode(...bytes.slice(0, 5))).toBe("%PDF-");
    expect(await opens(link.linkId)).toBe(1);
  });

  it("gives another site's POST the uniform 404 and counts nothing", async () => {
    const s = await shareablePrescription(A, PATIENT);
    const link = await linkFor(A, s.prescriptionId);
    for (const site of ["cross-site", "same-site"]) {
      const res = await post(link.token, { "sec-fetch-site": site });
      expect(res.status).toBe(404);
    }
    expect(await opens(link.linkId)).toBe(0);
  });

  it("answers 503 with Retry-After when the PDF service is down, and burns no open", async () => {
    const s = await shareablePrescription(A, PATIENT);
    const link = await linkFor(A, s.prescriptionId);
    engine.failWith = "pdf_unavailable";
    const res = await post(link.token);
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("30");
    expect(await res.text()).not.toContain("Route Patient");
    expect(await opens(link.linkId)).toBe(0);
  });

  it("serves the PDF for the page's own form post under Referrer-Policy: no-referrer (Chromium sends Origin: null with Sec-Fetch-Site: same-origin)", async () => {
    const s = await shareablePrescription(A, PATIENT);
    const link = await linkFor(A, s.prescriptionId);
    const res = await post(link.token, { origin: "null", "sec-fetch-site": "same-origin", host: "localhost:3000" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(await opens(link.linkId)).toBe(1);
  });

  it("decides on Sec-Fetch-Site alone when it is present, and on Origin only when it is absent", async () => {
    const s = await shareablePrescription(A, PATIENT);
    const link = await linkFor(A, s.prescriptionId);
    const host = "localhost:3000";
    // Another site is refused even with a matching Origin.
    expect((await post(link.token, { "sec-fetch-site": "cross-site", origin: "http://localhost:3000", host })).status).toBe(404);
    expect((await post(link.token, { "sec-fetch-site": "same-site", origin: "null", host })).status).toBe(404);
    // No Sec-Fetch-Site: a different Origin host is refused, "null" and the page's own origin pass.
    expect((await post(link.token, { origin: "https://evil.example", host })).status).toBe(404);
    expect((await post(link.token, { origin: "not a url", host })).status).toBe(404);
    expect(await opens(link.linkId)).toBe(0);
    expect((await post(link.token, { origin: "null", host })).status).toBe(200);
    expect((await post(link.token, { origin: "http://localhost:3000", host })).status).toBe(200);
    expect(await opens(link.linkId)).toBe(2);
  });

  it("logs why a POST was refused, never the token", async () => {
    const s = await shareablePrescription(A, PATIENT);
    const link = await linkFor(A, s.prescriptionId);
    const spy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await post(link.token, { "sec-fetch-site": "cross-site" });
      const lines = spy.mock.calls.map((c) => c.join(" "));
      expect(lines.some((l) => l.includes("cross-site"))).toBe(true);
      expect(lines.join(" | ")).not.toContain(link.token);
    } finally {
      spy.mockRestore();
    }
  });

  it("answers a refused POST with exactly the bytes and headers of an unknown link's POST", async () => {
    const s = await shareablePrescription(A, PATIENT);
    const link = await linkFor(A, s.prescriptionId);
    const refused = await post(link.token, { "sec-fetch-site": "cross-site" });
    const unknown = await post("a".repeat(43), { "sec-fetch-site": "same-origin" });
    expect(refused.status).toBe(404);
    expect(await refused.clone().text()).toBe(await unknown.clone().text());
    expect(headerMap(refused)).toEqual(headerMap(unknown));
  });

  it("limits one link to a few requests a minute across addresses, and groups an IPv6 address by its /64", async () => {
    const tokenLimiter = createRateLimiter({ windowMs: 60_000, max: 2 });
    const from = (ip: string) => get("short", { "x-vercel-forwarded-for": ip }, { tokenLimiter });
    expect((await from("203.0.113.1")).status).toBe(404);
    expect((await from("203.0.113.2")).status).toBe(404);
    expect((await from("203.0.113.3")).status).toBe(429);
    const tight = createRateLimiter({ windowMs: 60_000, max: 2 });
    const v6 = (ip: string) => get("short", { "x-vercel-forwarded-for": ip }, { limiter: tight });
    expect((await v6("2001:db8:1:2:aaaa:bbbb:cccc:1")).status).toBe(404);
    expect((await v6("2001:db8:1:2:1111:2222:3333:4444")).status).toBe(404);
    expect((await v6("2001:db8:1:2::9")).status).toBe(429);
    expect((await v6("2001:db8:1:3::9")).status).toBe(404);
  });

  it("answers the double-tap with its own page, not the generic one, and counts one open", async () => {
    const s = await shareablePrescription(A, PATIENT);
    const link = await linkFor(A, s.prescriptionId);
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started: () => void = () => undefined;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    const slow = createFakePdfEngine(1);
    const original = slow.render.bind(slow);
    slow.render = async (doc, opts) => {
      started();
      await held;
      return original(doc, opts);
    };
    const first = post(link.token, {}, { engine: slow });
    await running;
    const second = await post(link.token, {}, { engine: slow });
    expect(second.status).toBe(503);
    expect(await second.text()).toContain("already opening");
    release();
    expect((await first).status).toBe(200);
    expect(await opens(link.linkId)).toBe(1);
  });

  it("puts frame-ancestors none on the PDF response", async () => {
    const s = await shareablePrescription(A, PATIENT);
    const link = await linkFor(A, s.prescriptionId);
    const res = await post(link.token, { "sec-fetch-site": "same-origin" });
    expect(res.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });

  it("answers 503 when the public PDF queue is full, and burns no open", async () => {
    const s = await shareablePrescription(A, PATIENT);
    const link = await linkFor(A, s.prescriptionId);
    const res = await post(link.token, {}, { pdfLimiter: createLimiter({ concurrency: 0, maxQueue: 0 }) });
    expect(res.status).toBe(503);
    expect(await opens(link.linkId)).toBe(0);
  });
});
