// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
  A = await createTestTenant("route");
});

afterAll(async () => {
  await A.cleanup();
});

beforeEach(() => {
  engine.failWith = null;
  deps = { limiter: createRateLimiter({ windowMs: 60_000, max: 1000 }), engine, pdfLimiter: createLimiter({ concurrency: 2, maxQueue: 5 }) };
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

  it("refuses a POST whose Origin names another host, and accepts the page's own origin", async () => {
    const s = await shareablePrescription(A, PATIENT);
    const link = await linkFor(A, s.prescriptionId);
    expect((await post(link.token, { origin: "https://evil.example", host: "localhost:3000" })).status).toBe(404);
    expect((await post(link.token, { origin: "null", host: "localhost:3000" })).status).toBe(404);
    expect(await opens(link.linkId)).toBe(0);
    expect((await post(link.token, { origin: "http://localhost:3000", host: "localhost:3000" })).status).toBe(200);
    expect(await opens(link.linkId)).toBe(1);
  });

  it("answers 503 when the public PDF queue is full, and burns no open", async () => {
    const s = await shareablePrescription(A, PATIENT);
    const link = await linkFor(A, s.prescriptionId);
    const res = await post(link.token, {}, { pdfLimiter: createLimiter({ concurrency: 0, maxQueue: 0 }) });
    expect(res.status).toBe(503);
    expect(await opens(link.linkId)).toBe(0);
  });
});
