// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";

vi.mock("@/server/auth/session", () => ({ getSessionContext: vi.fn(), requireSession: vi.fn() }));
vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/server/pdf", async () => {
  const { sharedFakeEngine } = await import("../helpers/fake-pdf-engine");
  return { getPdfEngine: () => sharedFakeEngine };
});

import { getSessionContext } from "@/server/auth/session";
import { adminDb } from "@/server/db/admin";
import { withTenant } from "@/server/db/tenant";
import { auditEvents, clinics, doctors, prescriptionOutputs } from "@/server/db/schema";
import { createPatient } from "@/server/services/patients";
import { amendPrescription, finalizePrescription, saveDraft, startPrescription } from "@/server/services/prescriptions";
import { listPrescriptionOutputs, renderPrescriptionPdf } from "@/server/services/rx-output";
import { GET as getDocument, HEAD as headDocument } from "@/app/(app)/prescriptions/[id]/document/route";
import { GET as getPdf, HEAD as headPdf } from "@/app/(app)/prescriptions/[id]/pdf/route";
import { GET as getPdfHealth } from "@/app/api/health/pdf/route";
import { RENDERER_VERSION } from "@/lib/rx-render/render";
import * as selfContained from "@/lib/rx-render/self-contained";
import { checkSelfContained } from "@/lib/rx-render/self-contained";
import { resetPdfHealthCache } from "@/server/pdf/health-cache";
import { createLimiter } from "@/server/pdf/limiter";
import type { PdfEngine } from "@/server/pdf/engine";
import { newId } from "@/lib/domain/ids";
import { createFakePdfEngine, fakePdfBytes, resetFakeEngine, sharedFakeEngine } from "../helpers/fake-pdf-engine";
import { createTestTenant, type TestTenant } from "../helpers/tenant";

// Lets one test make the output-log insert fail while every read still works.
const dbFault = vi.hoisted(() => ({ failInsert: false }));
vi.mock("@/server/db/tenant", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/db/tenant")>();
  return {
    ...actual,
    withTenant: ((tenantId: string, fn: (tx: never) => Promise<unknown>) =>
      actual.withTenant(tenantId, (tx) =>
        fn(
          new Proxy(tx, {
            get(target, prop) {
              const value = Reflect.get(target, prop, target);
              if (prop === "insert" && dbFault.failInsert) {
                return () => {
                  throw new Error("log write failed");
                };
              }
              return typeof value === "function" ? value.bind(target) : value;
            },
          }) as never,
        ),
      )) as typeof actual.withTenant,
  };
});

const session = vi.mocked(getSessionContext);
const PATIENT = "Route <b>Patient</b> आशा";
let A: TestTenant;
let B: TestTenant;
let finalizedId = "";
let draftId = "";
let amendDraftId = "";
let supersededId = "";

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const pdf = (id: string) => getPdf(new Request(`http://localhost/prescriptions/${id}/pdf`), params(id));
const documentFor = (id: string, purpose?: string) =>
  getDocument(new Request(`http://localhost/prescriptions/${id}/document${purpose ? `?purpose=${purpose}` : ""}`), params(id));

async function draft(patientId: string): Promise<string> {
  const started = await startPrescription(A.as("doctor"), { patientId });
  if (!started.ok) throw new Error(started.message);
  const saved = await saveDraft(A.as("doctor"), started.value.prescriptionId, { items: [{ drugName: "Route Drug", doseMorning: 1 }] }, { baseRevision: 0 });
  if (!saved.ok) throw new Error(saved.message);
  return started.value.prescriptionId;
}

async function finalized(patientId: string): Promise<string> {
  const id = await draft(patientId);
  const done = await finalizePrescription(A.as("doctor"), id, { expectedRevision: 1 });
  if (!done.ok) throw new Error(done.message);
  return id;
}

const outputsFor = (id: string) =>
  adminDb.select().from(prescriptionOutputs).where(eq(prescriptionOutputs.prescriptionId, id));
const auditFor = (id: string, action: string) =>
  withTenant(A.tenantId, (tx) => tx.select().from(auditEvents).where(and(eq(auditEvents.entityId, id), eq(auditEvents.action, action))));

beforeAll(async () => {
  A = await createTestTenant("outa");
  B = await createTestTenant("outb");
  await adminDb.insert(clinics).values({ tenantId: A.tenantId, name: "Output Clinic" });
  await adminDb.update(doctors).set({ displayName: "Dr Output", regNo: "OUT-1" }).where(eq(doctors.tenantId, A.tenantId));
  const created = await createPatient(A.as("reception"), { name: PATIENT });
  if (!created.ok) throw new Error(created.message);
  finalizedId = await finalized(created.value.id);
  draftId = await draft(created.value.id);
  supersededId = await finalized(created.value.id);
  const amended = await amendPrescription(A.as("doctor"), { prescriptionId: supersededId, reason: "Wrong dose" });
  if (!amended.ok) throw new Error(amended.message);
  amendDraftId = amended.value.prescriptionId;
  const done = await finalizePrescription(A.as("doctor"), amendDraftId, { expectedRevision: 0 });
  if (!done.ok) throw new Error(done.message);
});

afterAll(async () => {
  await A.cleanup();
  await B.cleanup();
});

beforeEach(() => {
  session.mockReset();
  session.mockResolvedValue(A.as("doctor"));
  resetFakeEngine(sharedFakeEngine);
  dbFault.failInsert = false;
  resetPdfHealthCache();
});

describe("GET /prescriptions/[id]/pdf", () => {
  it("returns the PDF with safe headers, logs the output, and audits ids and counts only", async () => {
    const res = await pdf(finalizedId);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="Rx-\d+-v1\.pdf"$/);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(new TextDecoder().decode((await res.arrayBuffer()).slice(0, 5))).toBe("%PDF-");

    expect(sharedFakeEngine.calls).toHaveLength(1);
    expect(sharedFakeEngine.calls[0].html).toContain("Route &lt;b&gt;Patient&lt;/b&gt;");
    expect(checkSelfContained(sharedFakeEngine.calls[0].html)).toEqual({ ok: true });
    expect(checkSelfContained(sharedFakeEngine.calls[0].footerHtml)).toEqual({ ok: true });

    const outputs = await outputsFor(finalizedId);
    expect(outputs).toHaveLength(1);
    expect(outputs[0]).toMatchObject({ kind: "pdf_download", pageCount: 2, templateKey: "general", paperSize: "A4" });
    expect(outputs[0].htmlSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(outputs[0].rendererVersion).toBe(RENDERER_VERSION);

    const events = await auditFor(finalizedId, "prescription.pdf_downloaded");
    expect(events).toHaveLength(1);
    expect(events[0].after).toEqual({ outputId: outputs[0].id, version: 1, template: "general", paperSize: "A4", pageCount: 2, engine: "chromium" });
    expect(JSON.stringify(events[0])).not.toContain("Route");
    expect(JSON.stringify(events[0])).not.toContain("Rx-");
  });

  it("logs a second row for a second download (output rows are insert-only)", async () => {
    const before = (await outputsFor(finalizedId)).filter((o) => o.kind === "pdf_download").length;
    expect((await pdf(finalizedId)).status).toBe(200);
    expect((await pdf(finalizedId)).status).toBe(200);
    const after = (await outputsFor(finalizedId)).filter((o) => o.kind === "pdf_download");
    expect(after).toHaveLength(before + 2);
    expect(new Set(after.map((o) => o.id)).size).toBe(after.length);
  });

  it.each(["owner", "reception", "nurse", "pharmacist"])("lets %s download", async (role) => {
    session.mockResolvedValue(A.as(role));
    expect((await pdf(finalizedId)).status).toBe(200);
  });

  it("answers 401 without a session", async () => {
    session.mockResolvedValue(null);
    const res = await pdf(finalizedId);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthenticated", message: "Sign in again to download this prescription." });
    expect(sharedFakeEngine.calls).toHaveLength(0);
  });

  it("answers accountants, malformed, unknown, and other-clinic ids with the same 404", async () => {
    const bodies: unknown[] = [];
    const statuses: number[] = [];
    const cases: Array<[Parameters<typeof session.mockResolvedValue>[0], string]> = [
      [A.as("accountant"), finalizedId],
      [A.as("doctor"), "not-a-uuid"],
      [A.as("doctor"), newId()],
      [B.as("doctor"), finalizedId],
    ];
    for (const [who, id] of cases) {
      session.mockResolvedValue(who);
      const res = await pdf(id);
      statuses.push(res.status);
      bodies.push(await res.json());
    }
    expect(statuses).toEqual([404, 404, 404, 404]);
    for (const body of bodies) expect(body).toEqual({ error: "not_found", message: "Prescription not found." });
    expect(sharedFakeEngine.calls).toHaveLength(0);
  });

  it("refuses drafts and amendment drafts with 409, never calls the engine, and logs nothing", async () => {
    const patient = await createPatient(A.as("reception"), { name: "Loop Patient" });
    if (!patient.ok) throw new Error(patient.message);
    const source = await finalized(patient.value.id);
    const amendment = await amendPrescription(A.as("doctor"), { prescriptionId: source, reason: "Loop check" });
    if (!amendment.ok) throw new Error(amendment.message);
    const openAmendmentId = amendment.value.prescriptionId;
    expect(openAmendmentId).not.toBe(draftId);
    for (const id of [draftId, openAmendmentId]) {
      const res = await pdf(id);
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: "conflict", message: "Finalize this prescription before printing or downloading it." });
      expect(await outputsFor(id)).toHaveLength(0);
    }
    expect(sharedFakeEngine.calls).toHaveLength(0);
  });

  it("answers 503 with a clear message when the PDF service is down, and logs nothing", async () => {
    const before = (await outputsFor(finalizedId)).length;
    sharedFakeEngine.failWith = "pdf_unavailable";
    const res = await pdf(finalizedId);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "unavailable", message: "The PDF service is not available right now. Try again, or use Print." });
    expect(await outputsFor(finalizedId)).toHaveLength(before);
  });

  it("answers 504 on a timeout and logs nothing", async () => {
    const before = (await outputsFor(finalizedId)).length;
    sharedFakeEngine.failWith = "pdf_timeout";
    const res = await pdf(finalizedId);
    expect(res.status).toBe(504);
    expect(await res.json()).toEqual({ error: "timeout", message: expect.stringMatching(/too long/) });
    expect(await outputsFor(finalizedId)).toHaveLength(before);
  });

  it.each(["pdf_too_large", "pdf_refused"] as const)("answers 422 for %s and logs nothing", async (code) => {
    const before = (await outputsFor(finalizedId)).length;
    sharedFakeEngine.failWith = code;
    const res = await pdf(finalizedId);
    expect(res.status).toBe(422);
    expect(await outputsFor(finalizedId)).toHaveLength(before);
  });

  it("answers 503 for a generic engine failure without internals", async () => {
    sharedFakeEngine.failWith = "pdf_failed";
    const res = await pdf(finalizedId);
    expect(res.status).toBe(503);
    const text = JSON.stringify(await res.json());
    expect(text).not.toMatch(/http|localhost|gotenberg|configured|reachable|\\|stack/i);
  });

  it("answers 405 to HEAD without rendering, and 403 to a cross-site request", async () => {
    const before = (await outputsFor(finalizedId)).length;
    expect(headPdf().status).toBe(405);
    const cross = await getPdf(
      new Request(`http://localhost/prescriptions/${finalizedId}/pdf`, { headers: { "sec-fetch-site": "cross-site" } }),
      params(finalizedId),
    );
    expect(cross.status).toBe(403);
    expect(sharedFakeEngine.calls).toHaveLength(0);
    expect(await outputsFor(finalizedId)).toHaveLength(before);
    const same = await getPdf(
      new Request(`http://localhost/prescriptions/${finalizedId}/pdf`, { headers: { "sec-fetch-site": "same-origin" } }),
      params(finalizedId),
    );
    expect(same.status).toBe(200);
    expect(await outputsFor(finalizedId)).toHaveLength(before + 1);
  });

  it("answers 500 with no PDF bytes when the output log cannot be written", async () => {
    const before = (await outputsFor(finalizedId)).length;
    dbFault.failInsert = true;
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const res = await pdf(finalizedId);
      expect(res.status).toBe(500);
      expect(res.headers.get("content-type")).toContain("application/json");
      const body = await res.text();
      expect(body).not.toContain("%PDF");
      expect(JSON.parse(body)).toEqual({ error: "internal", message: "The PDF could not be generated. Try again, or use Print." });
    } finally {
      dbFault.failInsert = false;
      logged.mockRestore();
    }
    expect(await outputsFor(finalizedId)).toHaveLength(before);
  });

  it("answers a typed 500 and never calls the engine when the self-contained check fails", async () => {
    const before = (await outputsFor(finalizedId)).length;
    const check = vi.spyOn(selfContained, "checkSelfContained").mockReturnValue({ ok: false, reason: "external url for Route Patient" });
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const res = await pdf(finalizedId);
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: "internal", message: "The PDF could not be generated. Try again, or use Print." });
      expect(JSON.stringify(logged.mock.calls)).not.toContain("Route Patient");
    } finally {
      check.mockRestore();
      logged.mockRestore();
    }
    expect(sharedFakeEngine.calls).toHaveLength(0);
    expect(await outputsFor(finalizedId)).toHaveLength(before);
  });

  it("answers a typed 500 that leaks nothing when something unexpected throws, and logs no output", async () => {
    const before = (await outputsFor(finalizedId)).length;
    const render = vi.spyOn(sharedFakeEngine, "render").mockRejectedValueOnce(new Error("boom for Route Patient"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const res = await pdf(finalizedId);
      expect(res.status).toBe(500);
      expect(res.headers.get("cache-control")).toContain("no-store");
      expect(await res.json()).toEqual({ error: "internal", message: "The PDF could not be generated. Try again, or use Print." });
      expect(JSON.stringify(logged.mock.calls)).not.toContain("Route Patient");
      expect(await outputsFor(finalizedId)).toHaveLength(before);
    } finally {
      render.mockRestore();
      logged.mockRestore();
    }
  });
});

describe("renderPrescriptionPdf concurrency limit", () => {
  it("logs no download when the client disconnects during the render, and hands the engine the signal", async () => {
    const controller = new AbortController();
    const engine = createFakePdfEngine(1);
    const original = engine.render;
    engine.render = async (doc, opts) => {
      const outcome = await original(doc, opts);
      controller.abort(); // the client goes away while the engine works
      return outcome;
    };
    const before = (await outputsFor(finalizedId)).length;
    const result = await renderPrescriptionPdf(A.as("doctor"), finalizedId, engine, createLimiter({ concurrency: 1, maxQueue: 1 }), controller.signal);
    expect(result).toMatchObject({ ok: false, code: "unavailable", message: "The download was cancelled." });
    expect(engine.signals[0]).toBe(controller.signal);
    expect(await outputsFor(finalizedId)).toHaveLength(before);
  });

  it("does not render at all for a request that is already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const engine = createFakePdfEngine(1);
    const result = await renderPrescriptionPdf(A.as("doctor"), finalizedId, engine, createLimiter({ concurrency: 1, maxQueue: 1 }), controller.signal);
    expect(result).toMatchObject({ ok: false, message: "The download was cancelled." });
    expect(engine.calls).toHaveLength(0);
  });

  it("runs at most two renders at once, queues five, fails the rest fast with a busy message, and logs only produced PDFs", async () => {
    let started = 0;
    let running = 0;
    let peak = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow: PdfEngine = {
      async render() {
        started += 1;
        running += 1;
        peak = Math.max(peak, running);
        await gate;
        running -= 1;
        return { ok: true, pdf: fakePdfBytes(1), pageCount: 1 };
      },
      async health() {
        return { up: true, detail: "slow" };
      },
    };
    const limiter = createLimiter({ concurrency: 2, maxQueue: 5 });
    const before = (await outputsFor(finalizedId)).length;
    const settled: boolean[] = Array.from({ length: 8 }, () => false);
    const calls = settled.map((_, i) =>
      renderPrescriptionPdf(A.as("doctor"), finalizedId, slow, limiter).then((r) => {
        settled[i] = true;
        return r;
      }),
    );
    const deadline = Date.now() + 10_000;
    while ((started < 2 || settled.filter(Boolean).length < 1) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    expect(started).toBe(2);
    expect(settled.filter(Boolean)).toHaveLength(1); // the eighth request failed fast
    release();
    const results = await Promise.all(calls);
    const busy = results.filter((r) => !r.ok);
    expect(busy).toHaveLength(1);
    expect(busy[0]).toMatchObject({ ok: false, code: "unavailable", message: expect.stringMatching(/busy/) });
    expect(results.filter((r) => r.ok)).toHaveLength(7);
    expect(peak).toBe(2);
    expect(started).toBe(7);
    expect(await outputsFor(finalizedId)).toHaveLength(before + 7);
  });

  it("tells the route client to retry after 2 seconds when the service is busy", async () => {
    let started = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const render = vi.spyOn(sharedFakeEngine, "render").mockImplementation(async () => {
      started += 1;
      await gate;
      return { ok: true, pdf: fakePdfBytes(1), pageCount: 1 };
    });
    try {
      const calls = Array.from({ length: 7 }, () => pdf(finalizedId));
      const deadline = Date.now() + 10_000;
      while (started < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
      const busy = await pdf(finalizedId);
      expect(busy.status).toBe(503);
      expect(busy.headers.get("retry-after")).toBe("2");
      expect(await busy.json()).toEqual({ error: "unavailable", message: expect.stringMatching(/busy/) });
      release();
      expect((await Promise.all(calls)).every((r) => r.status === 200)).toBe(true);
    } finally {
      release();
      render.mockRestore();
    }
  });
});

describe("GET /prescriptions/[id]/document", () => {
  it("previews a draft with a watermark, a strict CSP, safe headers, and no output log", async () => {
    const res = await documentFor(draftId);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'self'");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(res.headers.get("content-disposition")).toBe('inline; filename="Rx-draft-v1.html"');
    const markup = await res.text();
    expect(markup).toContain("DRAFT · NOT VALID FOR DISPENSING");
    expect(markup).toContain('data-rx="ready"');
    expect(checkSelfContained(markup)).toEqual({ ok: true });
    expect(await outputsFor(draftId)).toHaveLength(0);
    expect(await auditFor(draftId, "prescription.previewed")).toHaveLength(0);
  });

  it("audits a preview of a finalized prescription with ids only, without an output row", async () => {
    const outputsBefore = (await outputsFor(finalizedId)).length;
    const eventsBefore = (await auditFor(finalizedId, "prescription.previewed")).length;
    expect((await documentFor(finalizedId)).status).toBe(200);
    const events = await auditFor(finalizedId, "prescription.previewed");
    expect(events).toHaveLength(eventsBefore + 1);
    expect(events[events.length - 1].after).toEqual({ prescriptionId: finalizedId, version: 1 });
    expect(JSON.stringify(events)).not.toContain("Route");
    expect(await outputsFor(finalizedId)).toHaveLength(outputsBefore);
    const summary = await listPrescriptionOutputs(A.as("reception"), finalizedId);
    expect(summary.ok && summary.value.count).toBe(outputsBefore);
  });

  it("refuses a cross-site preview too, without an audit event, and serves same-origin and address-bar views", async () => {
    const url = `http://localhost/prescriptions/${finalizedId}/document`;
    const before = (await auditFor(finalizedId, "prescription.previewed")).length;
    const cross = await getDocument(new Request(url, { headers: { "sec-fetch-site": "cross-site" } }), params(finalizedId));
    expect(cross.status).toBe(403);
    expect((await auditFor(finalizedId, "prescription.previewed")).length).toBe(before);
    for (const site of ["same-origin", "none"]) {
      const ok = await getDocument(new Request(url, { headers: { "sec-fetch-site": site } }), params(finalizedId));
      expect(ok.status).toBe(200);
    }
    expect((await auditFor(finalizedId, "prescription.previewed")).length).toBe(before + 2);
  });

  it("answers 405 to HEAD, and refuses a cross-site print without logging", async () => {
    expect(headDocument().status).toBe(405);
    const before = (await outputsFor(finalizedId)).length;
    const cross = await getDocument(
      new Request(`http://localhost/prescriptions/${finalizedId}/document?purpose=print`, { headers: { "sec-fetch-site": "cross-site" } }),
      params(finalizedId),
    );
    expect(cross.status).toBe(403);
    expect(await outputsFor(finalizedId)).toHaveLength(before);
    const same = await getDocument(
      new Request(`http://localhost/prescriptions/${finalizedId}/document?purpose=print`, { headers: { "sec-fetch-site": "same-origin" } }),
      params(finalizedId),
    );
    expect(same.status).toBe(200);
    expect(await outputsFor(finalizedId)).toHaveLength(before + 1);
  });

  it("answers a typed 500 when the self-contained check fails, and logs nothing", async () => {
    const before = (await outputsFor(finalizedId)).length;
    const check = vi.spyOn(selfContained, "checkSelfContained").mockReturnValue({ ok: false, reason: "x" });
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const res = await documentFor(finalizedId, "print");
      expect(res.status).toBe(500);
      expect(await res.text()).toContain('data-rx="error"');
    } finally {
      check.mockRestore();
      logged.mockRestore();
    }
    expect(await outputsFor(finalizedId)).toHaveLength(before);
  });

  it("names an amendment draft without its parent's number", async () => {
    const started = await amendPrescription(A.as("doctor"), { prescriptionId: finalizedId, reason: "Preview name" });
    if (!started.ok) throw new Error(started.message);
    const res = await documentFor(started.value.prescriptionId);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe('inline; filename="Rx-draft-v2.html"');
    expect((await pdf(started.value.prescriptionId)).status).toBe(409);
    expect(await outputsFor(started.value.prescriptionId)).toHaveLength(0);
  });

  it("refuses to print a draft and logs nothing", async () => {
    const res = await documentFor(draftId, "print");
    expect(res.status).toBe(409);
    expect(await res.text()).toContain('data-rx="error"');
    expect(await outputsFor(draftId)).toHaveLength(0);
  });

  it("logs and audits a print, and prints byte-identical HTML every time", async () => {
    const printsBefore = (await outputsFor(finalizedId)).filter((o) => o.kind === "browser_print").length;
    const auditBefore = (await auditFor(finalizedId, "prescription.printed")).length;
    const first = await (await documentFor(finalizedId, "print")).text();
    const second = await (await documentFor(finalizedId, "print")).text();
    expect(second).toBe(first);
    const prints = (await outputsFor(finalizedId)).filter((o) => o.kind === "browser_print");
    expect(prints).toHaveLength(printsBefore + 2);
    expect(prints[0].htmlSha256).toBe(prints[prints.length - 1].htmlSha256);
    expect(prints[0].pageCount).toBeNull();
    expect(prints.every((o) => o.rendererVersion === RENDERER_VERSION)).toBe(true);
    expect(await auditFor(finalizedId, "prescription.printed")).toHaveLength(auditBefore + 2);

    const summary = await listPrescriptionOutputs(A.as("reception"), finalizedId);
    expect(summary.ok && summary.value.count).toBeGreaterThanOrEqual(2);
    expect(summary.ok && summary.value.lastAt instanceof Date).toBe(true);
  });

  it("marks a superseded version", async () => {
    expect(await (await documentFor(supersededId, "print")).text()).toContain("SUPERSEDED by version 2");
    expect(await (await documentFor(amendDraftId, "print")).text()).not.toContain("SUPERSEDED");
  });

  it("sends a signed-out user to the login page and hides other clinics' prescriptions", async () => {
    session.mockResolvedValue(null);
    const res = await documentFor(finalizedId, "print");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("http://localhost/login");
    session.mockResolvedValue(B.as("owner"));
    const hidden = await documentFor(finalizedId);
    expect(hidden.status).toBe(404);
    expect(await hidden.text()).not.toContain("Route");
  });

  it("answers an accountant exactly like an unknown id", async () => {
    session.mockResolvedValue(A.as("accountant"));
    const forbidden = await documentFor(finalizedId, "print");
    session.mockResolvedValue(A.as("doctor"));
    const unknown = await documentFor(newId(), "print");
    expect(forbidden.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(await forbidden.text()).toBe(await unknown.text());
  });
});

describe("GET /api/health/pdf", () => {
  it("reports the PDF service state without detail", async () => {
    const up = await getPdfHealth();
    expect(up.status).toBe(200);
    expect(up.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await up.json()).toEqual({ status: "up", service: "pdf" });
    sharedFakeEngine.up = false;
    expect((await getPdfHealth()).status).toBe(200); // cached for a few seconds
    resetPdfHealthCache();
    const down = await getPdfHealth();
    expect(down.status).toBe(503);
    expect(await down.json()).toEqual({ status: "down", service: "pdf" });
  });

  it("expires the cached result after about three seconds", async () => {
    const now = vi.spyOn(Date, "now");
    try {
      now.mockReturnValue(1_000_000);
      expect((await getPdfHealth()).status).toBe(200);
      sharedFakeEngine.up = false;
      now.mockReturnValue(1_002_000);
      expect((await getPdfHealth()).status).toBe(200);
      now.mockReturnValue(1_003_500);
      expect((await getPdfHealth()).status).toBe(503);
    } finally {
      now.mockRestore();
    }
  });
});
