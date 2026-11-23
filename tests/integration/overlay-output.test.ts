// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";

vi.mock("@/server/auth/session", () => ({ getSessionContext: vi.fn(), requireSession: vi.fn() }));
vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/server/pdf", async () => {
  const { sharedFakeEngine } = await import("../helpers/fake-pdf-engine");
  return { getPdfEngine: () => sharedFakeEngine };
});

import { createHash } from "node:crypto";
import { getSessionContext } from "@/server/auth/session";
import { adminDb } from "@/server/db/admin";
import { auditEvents, clinics, prescriptionOutputs, templateFiles, templates, templateVersions } from "@/server/db/schema";
import { htmlSha256, renderPrescriptionHtml, renderPrescriptionPdf } from "@/server/services/rx-output";
import { openSharedPrescription } from "@/server/services/share-open";
import { TEMPLATE_DAMAGED_MESSAGE } from "@/server/services/template-resolution";
import { createLimiter } from "@/server/pdf/limiter";
import { GET as getPdf } from "@/app/(app)/prescriptions/[id]/pdf/route";
import { resetFakeEngine, sharedFakeEngine } from "../helpers/fake-pdf-engine";
import { finalized, newPatient, savedDraft } from "../helpers/rx-flow";
import { linkFor, shareablePrescription } from "../helpers/share";
import { backgroundPng, insertPublishedOverlay, MINIMAL_OVERLAY_DEFINITION, publishNewVersion } from "../helpers/templates";
import { createTestTenant, type TestTenant } from "../helpers/tenant";

const session = vi.mocked(getSessionContext);
let A: TestTenant;
let pad: Awaited<ReturnType<typeof insertPublishedOverlay>>;
let rxId = "";

const outputsOf = (id: string) => adminDb.select().from(prescriptionOutputs).where(eq(prescriptionOutputs.prescriptionId, id));
const printHtml = async (id: string) => {
  const result = await renderPrescriptionHtml(A.as("doctor"), id, "print");
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  return result.value.html;
};

beforeAll(async () => {
  A = await createTestTenant("overlay-out");
  pad = await insertPublishedOverlay(A.tenantId, { definition: { ...MINIMAL_OVERLAY_DEFINITION, background: { printMode: "pdf_only" } } });
  await adminDb.update(clinics).set({ customTemplateId: pad.templateId }).where(eq(clinics.tenantId, A.tenantId));
  rxId = await finalized(A.as("doctor"), await newPatient(A.as("reception"), "Overlay Output Patient"));
});
afterAll(async () => {
  await A.cleanup();
});
beforeEach(() => {
  resetFakeEngine(sharedFakeEngine);
  session.mockResolvedValue(A.as("doctor"));
});

describe("printing a prescription finalized on a custom pad", () => {
  it("prints the frozen overlay and logs the version, the engine and the overlay renderer", async () => {
    const html = await printHtml(rxId);
    expect(html).toContain('<table class="flow">');
    expect(html).not.toContain('class="bg"'); // pdf_only: printed on pre-printed paper
    const [row] = (await outputsOf(rxId)).filter((o) => o.kind === "browser_print");
    expect(row).toMatchObject({ templateKey: "overlay", templateVersionId: pad.versionId, engine: "browser", rendererVersion: "overlay-1" });
  });

  it("downloads the PDF with the background, zero margins, and engine chromium", async () => {
    const result = await renderPrescriptionPdf(A.as("doctor"), rxId, sharedFakeEngine, createLimiter({ concurrency: 1, maxQueue: 1 }));
    expect(result.ok).toBe(true);
    expect(sharedFakeEngine.calls[0].html).toContain('class="bg"');
    expect(sharedFakeEngine.calls[0].paper.marginMm).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
    const rows = (await outputsOf(rxId)).filter((o) => o.kind === "pdf_download");
    expect(rows.at(-1)).toMatchObject({ templateKey: "overlay", templateVersionId: pad.versionId, engine: "chromium" });
    const [event] = await adminDb.select().from(auditEvents).where(and(eq(auditEvents.entityId, rxId), eq(auditEvents.action, "prescription.pdf_downloaded")));
    expect(event.after).toMatchObject({ template: "overlay", templateVersionId: pad.versionId, engine: "chromium" });
  });

  it("prints through a PDF rendered for paper (Firefox and Safari): logged as a print by chromium, inline", async () => {
    const response = await getPdf(new Request(`http://localhost/prescriptions/${rxId}/pdf?purpose=print`), { params: Promise.resolve({ id: rxId }) });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toMatch(/^inline;/);
    expect(sharedFakeEngine.calls[0].html).not.toContain('class="bg"');
    const rows = (await outputsOf(rxId)).filter((o) => o.kind === "browser_print" && o.engine === "chromium");
    expect(rows).toHaveLength(1);
  });

  it("reprints byte for byte after the pad is edited, archived and replaced as the default", async () => {
    const first = htmlSha256(await printHtml(rxId));
    await publishNewVersion(A.tenantId, pad.templateId);
    await adminDb.update(clinics).set({ customTemplateId: null }).where(eq(clinics.tenantId, A.tenantId));
    await adminDb.update(templates).set({ status: "archived" }).where(eq(templates.id, pad.templateId));
    const other = await insertPublishedOverlay(A.tenantId);
    await adminDb.update(clinics).set({ customTemplateId: other.templateId }).where(eq(clinics.tenantId, A.tenantId));
    expect(htmlSha256(await printHtml(rxId))).toBe(first);
    await adminDb.update(templates).set({ status: "active" }).where(eq(templates.id, pad.templateId));
  });

  it("refuses to print when the frozen version or its file was tampered with, and logs nothing", async () => {
    const victim = await insertPublishedOverlay(A.tenantId);
    await adminDb.update(clinics).set({ customTemplateId: victim.templateId }).where(eq(clinics.tenantId, A.tenantId));
    const id = await finalized(A.as("doctor"), await newPatient(A.as("reception"), "Tamper Patient"));
    const swapped = backgroundPng("swapped-background");
    await adminDb.transaction(async (tx) => {
      await tx.execute(sql`set local session_replication_role = replica`);
      await tx
        .update(templateFiles)
        .set({ bytes: swapped, byteSize: swapped.length, sha256: createHash("sha256").update(swapped).digest("hex") })
        .where(eq(templateFiles.id, victim.fileId));
    });
    expect(await renderPrescriptionHtml(A.as("doctor"), id, "print")).toEqual({ ok: false, code: "invalid", message: TEMPLATE_DAMAGED_MESSAGE });
    expect(await outputsOf(id)).toHaveLength(0);
    await adminDb.transaction(async (tx) => {
      await tx.execute(sql`set local session_replication_role = replica`);
      await tx.update(templateVersions).set({ labels: "hi" }).where(eq(templateVersions.id, victim.versionId));
    });
    expect((await renderPrescriptionHtml(A.as("doctor"), id, "preview")).ok).toBe(false);
  });
});

describe("drafts and shares", () => {
  it("previews a draft on the would-be signer's pad, unlogged", async () => {
    const fresh = await insertPublishedOverlay(A.tenantId);
    await adminDb.update(clinics).set({ customTemplateId: fresh.templateId }).where(eq(clinics.tenantId, A.tenantId));
    const { id } = await savedDraft(A.as("doctor"), await newPatient(A.as("reception"), "Draft Overlay Patient"));
    const preview = await renderPrescriptionHtml(A.as("reception"), id, "preview");
    expect(preview.ok && preview.value.html.includes('<table class="flow">') && preview.value.html.includes("DRAFT")).toBe(true);
    expect(await outputsOf(id)).toHaveLength(0);
  });

  it("opens a shared overlay prescription and logs the frozen version", async () => {
    const shared = await shareablePrescription(A, "Shared Overlay Patient");
    const link = await linkFor(A, shared.prescriptionId);
    const opened = await openSharedPrescription(link.token, { engine: sharedFakeEngine, limiter: createLimiter({ concurrency: 1, maxQueue: 1 }) });
    expect(opened.ok).toBe(true);
    const [row] = await adminDb.select().from(prescriptionOutputs).where(eq(prescriptionOutputs.shareLinkId, link.linkId));
    expect(row).toMatchObject({ kind: "shared_pdf", templateKey: "overlay", engine: "chromium" });
    expect(row.templateVersionId).not.toBeNull();
  });
  it("answers the uniform not-found for a share whose pinned pad was tampered with, and logs nothing", async () => {
    const victim = await insertPublishedOverlay(A.tenantId);
    await adminDb.update(clinics).set({ customTemplateId: victim.templateId }).where(eq(clinics.tenantId, A.tenantId));
    const shared = await shareablePrescription(A, "Tampered Share Patient");
    const link = await linkFor(A, shared.prescriptionId);
    const swapped = backgroundPng("swapped-share-background");
    await adminDb.transaction(async (tx) => {
      await tx.execute(sql`set local session_replication_role = replica`);
      await tx
        .update(templateFiles)
        .set({ bytes: swapped, byteSize: swapped.length, sha256: createHash("sha256").update(swapped).digest("hex") })
        .where(eq(templateFiles.id, victim.fileId));
    });
    const opened = await openSharedPrescription(link.token, { engine: sharedFakeEngine, limiter: createLimiter({ concurrency: 1, maxQueue: 1 }) });
    expect(opened).toEqual({ ok: false, code: "not_found", message: "This link is not valid." });
    expect(await adminDb.select().from(prescriptionOutputs).where(eq(prescriptionOutputs.shareLinkId, link.linkId))).toHaveLength(0);
  });
});
