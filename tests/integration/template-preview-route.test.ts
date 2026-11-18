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
import { auditEvents, prescriptionOutputs } from "@/server/db/schema";
import { checkSelfContained } from "@/lib/rx-render/self-contained";
import { newId } from "@/lib/domain/ids";
import { GET, HEAD } from "@/app/(app)/templates/[id]/preview/route";
import { resetFakeEngine, sharedFakeEngine } from "../helpers/fake-pdf-engine";
import { finalized, newPatient, savedDraft } from "../helpers/rx-flow";
import { insertPublishedOverlay, insertTemplate, MINIMAL_OVERLAY_DEFINITION } from "../helpers/templates";
import { createTestTenant, type TestTenant } from "../helpers/tenant";

const session = vi.mocked(getSessionContext);
let A: TestTenant;
let B: TestTenant;
let templateId = "";
let rxId = "";
let draftRxId = "";
let foreignRx = "";

const preview = (id: string, query: string, headers: Record<string, string> = {}) =>
  GET(new Request(`http://localhost/templates/${id}/preview?${query}`, { headers }), { params: Promise.resolve({ id }) });
// The pad background is the only image these previews may carry.
const imageCount = (html: string) => (html.match(/<img/g) ?? []).length;
const events = (tenantId: string, action: string) =>
  adminDb.select().from(auditEvents).where(and(eq(auditEvents.tenantId, tenantId), eq(auditEvents.action, action)));

beforeAll(async () => {
  A = await createTestTenant("tpl-preview-a");
  B = await createTestTenant("tpl-preview-b");
  templateId = (await insertPublishedOverlay(A.tenantId)).templateId;
  const patient = await newPatient(A.as("reception"), "Preview Patient आशा");
  rxId = await finalized(A.as("doctor"), patient);
  draftRxId = (await savedDraft(A.as("doctor"), await newPatient(A.as("reception"), "Draft Patient"))).id;
  foreignRx = await finalized(B.as("doctor"), await newPatient(B.as("reception"), "Other Clinic Patient"));
});
afterAll(async () => {
  await A.cleanup();
  await B.cleanup();
});
beforeEach(() => {
  resetFakeEngine(sharedFakeEngine);
  session.mockResolvedValue(A.as("owner"));
});

describe("GET /templates/<id>/preview", () => {
  it("renders a self-contained sample preview marked SAMPLE with a placeholder doctor, and logs nothing", async () => {
    const response = await preview(templateId, "sample=long");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    const html = await response.text();
    expect(checkSelfContained(html)).toEqual({ ok: true });
    expect(html).toContain("SAMPLE · NOT A PRESCRIPTION");
    expect(html).toContain('<table class="flow">');
    expect(html).toContain("Dr. Sample Doctor");
    expect(imageCount(html)).toBe(1); // the pad background only: no logo or signature in this fixture
    expect(await events(A.tenantId, "template.previewed_with_patient")).toHaveLength(0);
    expect(await events(A.tenantId, "prescription.previewed")).toHaveLength(0);
  });

  it("never draws a signature image in a sample, in a box or end-of-content signature mode", async () => {
    const boxed = {
      ...MINIMAL_OVERLAY_DEFINITION,
      boxes: [
        ...MINIMAL_OVERLAY_DEFINITION.boxes,
        { id: "b3", field: "doctor.signature", xMm: 140, yMm: 250, wMm: 50, hMm: 20, fontPt: 10, align: "left", bold: false, repeat: "first_page" },
      ],
      signature: { mode: "box" },
    };
    const { templateId: boxedId } = await insertPublishedOverlay(A.tenantId, { definition: boxed });
    for (const id of [templateId, boxedId]) {
      const html = await (await preview(id, "sample=short")).text();
      expect(imageCount(html)).toBe(1); // the pad background only: no logo or signature in this fixture
      expect(html).toContain("SAMPLE · NOT A PRESCRIPTION");
    }
  });

  it("previews a real patient as a draft (no Rx number, no signature), audits ids only, and writes no output row", async () => {
    const response = await preview(templateId, `prescriptionId=${rxId}`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("DRAFT · NOT VALID FOR DISPENSING");
    expect(html).toContain("Preview Patient");
    expect(imageCount(html)).toBe(1); // the pad background only: no logo or signature in this fixture
    const [event] = await events(A.tenantId, "template.previewed_with_patient");
    expect(event.after).toEqual({ templateId, templateVersionId: expect.any(String), prescriptionId: rxId });
    expect(JSON.stringify(event)).not.toContain("Preview Patient");
    // A signed record was shown: the ordinary document-route audit applies too.
    expect(await events(A.tenantId, "prescription.previewed")).toHaveLength(1);
    expect(await adminDb.select().from(prescriptionOutputs).where(eq(prescriptionOutputs.prescriptionId, rxId))).toHaveLength(0);
  });

  it("previews a draft prescription without the signed-record audit", async () => {
    const before = (await events(A.tenantId, "prescription.previewed")).length;
    expect((await preview(templateId, `prescriptionId=${draftRxId}`)).status).toBe(200);
    expect((await events(A.tenantId, "prescription.previewed")).length).toBe(before);
  });

  it("never lets a designer see a patient, but lets them see samples", async () => {
    session.mockResolvedValue({ tenantId: A.tenantId, userId: newId(), role: "designer" });
    expect((await preview(templateId, `prescriptionId=${rxId}`)).status).toBe(404);
    expect((await preview(templateId, "sample=short")).status).toBe(200);
  });

  it("answers 404 for roles without template.read, another clinic's template or prescription, a foreign version, and a bad query", async () => {
    session.mockResolvedValue(A.as("reception"));
    expect((await preview(templateId, "sample=short")).status).toBe(404);
    session.mockResolvedValue(B.as("owner"));
    expect((await preview(templateId, "sample=short")).status).toBe(404);
    session.mockResolvedValue(A.as("owner"));
    expect((await preview(templateId, `prescriptionId=${foreignRx}`)).status).toBe(404);
    const other = await insertTemplate(A.tenantId);
    expect((await preview(templateId, `sample=short&version=${other.versionId}`)).status).toBe(404);
    expect((await preview(templateId, "sample=huge")).status).toBe(404);
    expect((await preview(templateId, "")).status).toBe(404);
    expect((await preview("not-a-uuid", "sample=short")).status).toBe(404);
  });

  it("renders a PDF preview through the engine, inline, and writes no output row", async () => {
    const response = await preview(templateId, "sample=blank&format=pdf");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("content-disposition")).toMatch(/^inline;/);
    expect(sharedFakeEngine.calls).toHaveLength(1);
    expect(await adminDb.select().from(prescriptionOutputs).where(eq(prescriptionOutputs.tenantId, A.tenantId))).toHaveLength(0);
  });

  it("refuses cross-site requests and HEAD", async () => {
    expect((await preview(templateId, "sample=short", { "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect(HEAD().status).toBe(405);
  });
});
