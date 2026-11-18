import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { adminDb } from "@/server/db/admin";
import { auditEvents, clinics, doctors, prescriptions, templates, templateVersions, tenantCounters, users } from "@/server/db/schema";
import { defaultOverlayDefinition } from "@/lib/rx-render/overlay-definition";
import { parseRenderSnapshot } from "@/lib/rx-render/snapshot";
import { amendPrescription, finalizePrescription, repeatPrescription } from "@/server/services/prescriptions";
import { TEMPLATE_UNUSABLE_MESSAGE } from "@/server/services/template-resolution";
import type { ServiceContext } from "@/server/services/context";
import { finalized, newPatient, savedDraft } from "../helpers/rx-flow";
import { insertPublishedOverlay, insertTemplate, MINIMAL_OVERLAY_DEFINITION, publishNewVersion } from "../helpers/templates";
import { createTestTenant, type TestTenant } from "../helpers/tenant";

let A: TestTenant;
let doctorA = "";
let secondDoctorUser = "";
let secondDoctorRow = "";
let patientId = "";
const doctor = () => A.as("doctor");
const second = (): ServiceContext => ({ tenantId: A.tenantId, userId: secondDoctorUser, role: "doctor" });

async function rxRow(id: string) {
  const [row] = await adminDb.select().from(prescriptions).where(eq(prescriptions.id, id));
  return { row, snap: parseRenderSnapshot(row.renderSnapshot) };
}
const setClinicTemplate = (templateId: string | null) => adminDb.update(clinics).set({ customTemplateId: templateId }).where(eq(clinics.tenantId, A.tenantId));
const setDoctorTemplate = (doctorId: string, templateId: string | null) => adminDb.update(doctors).set({ templateId }).where(eq(doctors.id, doctorId));

beforeAll(async () => {
  A = await createTestTenant("tpl-resolve");
  const [row] = await adminDb.select({ id: doctors.id }).from(doctors).where(eq(doctors.tenantId, A.tenantId)).limit(1);
  doctorA = row.id;
  const [user] = await adminDb
    .insert(users)
    .values({ email: `tpl-resolve-2-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`, name: "Dr Second", passwordHash: "not-a-real-hash" })
    .returning();
  secondDoctorUser = user.id;
  const [docRow] = await adminDb.insert(doctors).values({ tenantId: A.tenantId, userId: user.id, displayName: "Dr Second", regNo: "MMC-3333" }).returning();
  secondDoctorRow = docRow.id;
  patientId = await newPatient(A.as("reception"), "Resolution Patient");
});
afterAll(async () => {
  try {
    await A.cleanup();
  } finally {
    if (secondDoctorUser) await adminDb.delete(users).where(eq(users.id, secondDoctorUser));
  }
});
beforeEach(async () => {
  await setClinicTemplate(null);
  await adminDb.update(doctors).set({ templateId: null }).where(eq(doctors.tenantId, A.tenantId));
});

describe("resolution at finalize", () => {
  it("prints on the built-in pad (snapshot version 1, unchanged shape) when nothing is assigned", async () => {
    const { row, snap } = await rxRow(await finalized(doctor(), patientId));
    expect(row.templateVersionId).toBeNull();
    expect(snap?.v).toBe(1);
    expect(snap?.layout.template).toEqual({ kind: "builtin", key: "general" });
  });

  it("freezes the clinic default's published version, its hash, and its paper and labels as snapshot version 2", async () => {
    const t = await insertPublishedOverlay(A.tenantId, { paperSize: "A5", labels: "bilingual", definition: defaultOverlayDefinition("A5") });
    await setClinicTemplate(t.templateId);
    const id = await finalized(doctor(), patientId);
    const { row, snap } = await rxRow(id);
    expect(row.templateVersionId).toBe(t.versionId);
    expect(snap?.v).toBe(2);
    expect(snap?.layout).toEqual({ template: { kind: "overlay", templateVersionId: t.versionId, contentSha256: t.contentSha256 }, paperSize: "A5", labels: "bilingual" });
    // The audit payload names the version (ids only).
    const [event] = await adminDb.select().from(auditEvents).where(and(eq(auditEvents.entityId, id), eq(auditEvents.action, "prescription.finalized")));
    expect(event.after).toMatchObject({ templateVersionId: t.versionId });
  });

  it("prefers the signing doctor's own template over the clinic default", async () => {
    const clinicPad = await insertPublishedOverlay(A.tenantId);
    const own = await insertPublishedOverlay(A.tenantId, { identity: "bound", boundDoctorId: doctorA });
    await setClinicTemplate(clinicPad.templateId);
    await setDoctorTemplate(doctorA, own.templateId);
    expect((await rxRow(await finalized(doctor(), patientId))).row.templateVersionId).toBe(own.versionId);
    expect((await rxRow(await finalized(second(), patientId))).row.templateVersionId).toBe(clinicPad.versionId);
  });

  it("never prints Dr A's bound letterhead for Dr B, even if it is assigned to Dr B or set as the clinic default", async () => {
    const boundToA = await insertPublishedOverlay(A.tenantId, { identity: "bound", boundDoctorId: doctorA });
    await setClinicTemplate(boundToA.templateId);
    await setDoctorTemplate(secondDoctorRow, boundToA.templateId);
    const { row, snap } = await rxRow(await finalized(second(), patientId));
    expect(row.templateVersionId).toBeNull();
    expect(snap?.layout.template.kind).toBe("builtin");
  });

  it("reads the binding from the CURRENT VERSION, not from an older one (override 2)", async () => {
    // v1 is bound to Dr A; v2 is dynamic and current: Dr B may use it. Then v3 is bound to Dr A again: Dr B may not.
    const pad = await insertPublishedOverlay(A.tenantId, { identity: "bound", boundDoctorId: doctorA });
    await setClinicTemplate(pad.templateId);
    expect((await rxRow(await finalized(second(), patientId))).row.templateVersionId).toBeNull();
    const dynamic = await publishNewVersion(A.tenantId, pad.templateId);
    expect((await rxRow(await finalized(second(), patientId))).row.templateVersionId).toBe(dynamic.versionId);
    const boundAgain = await publishNewVersion(A.tenantId, pad.templateId, { identity: "bound", boundDoctorId: doctorA });
    expect((await rxRow(await finalized(second(), patientId))).row.templateVersionId).toBeNull();
    expect((await rxRow(await finalized(doctor(), patientId))).row.templateVersionId).toBe(boundAgain.versionId);
  });

  it("skips archived templates and templates that were never published", async () => {
    const archived = await insertPublishedOverlay(A.tenantId);
    await adminDb.update(templates).set({ status: "archived" }).where(eq(templates.id, archived.templateId));
    const unpublished = await insertTemplate(A.tenantId);
    await setDoctorTemplate(doctorA, archived.templateId);
    await setClinicTemplate(unpublished.templateId);
    expect((await rxRow(await finalized(doctor(), patientId))).row.templateVersionId).toBeNull();
  });

  it("uses only a dynamic clinic default for an owner without a doctor profile", async () => {
    const [user] = await adminDb
      .insert(users)
      .values({ email: `tpl-owner-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`, name: "Owner", passwordHash: "not-a-real-hash" })
      .returning();
    try {
      const owner: ServiceContext = { tenantId: A.tenantId, userId: user.id, role: "owner" };
      const bound = await insertPublishedOverlay(A.tenantId, { identity: "bound", boundDoctorId: doctorA });
      await setClinicTemplate(bound.templateId);
      expect((await rxRow(await finalized(owner, patientId))).row.templateVersionId).toBeNull();
      const dynamic = await insertPublishedOverlay(A.tenantId);
      await setClinicTemplate(dynamic.templateId);
      expect((await rxRow(await finalized(owner, patientId))).row.templateVersionId).toBe(dynamic.versionId);
    } finally {
      await adminDb.delete(users).where(eq(users.id, user.id));
    }
  });

  it("fails closed on a damaged template: nothing finalized, no Rx number used", async () => {
    const t = await insertPublishedOverlay(A.tenantId);
    await setClinicTemplate(t.templateId);
    // Simulate tampering outside the app: replica mode skips the immutability trigger (superuser only). The tampered
    // definition still parses under the frozen v1 schema, so only the content hash can catch it.
    const tampered = { ...structuredClone(MINIMAL_OVERLAY_DEFINITION), printOffsetMm: { x: 9, y: 9 } };
    await adminDb.transaction(async (tx) => {
      await tx.execute(sql`set local session_replication_role = replica`);
      await tx.update(templateVersions).set({ definition: tampered }).where(eq(templateVersions.id, t.versionId));
    });
    const counter = async () => (await adminDb.select().from(tenantCounters).where(and(eq(tenantCounters.tenantId, A.tenantId), eq(tenantCounters.name, "rx"))))[0]?.lastNo ?? 0;
    const before = await counter();
    const { id, revision } = await savedDraft(doctor(), patientId);
    expect(await finalizePrescription(doctor(), id, { expectedRevision: revision })).toEqual({ ok: false, code: "invalid", message: TEMPLATE_UNUSABLE_MESSAGE });
    expect((await rxRow(id)).row.status).toBe("draft");
    expect(await counter()).toBe(before);
  });
});

describe("new versions of a record", () => {
  it("an amendment resolves its own pad; the original keeps the one it was signed on", async () => {
    const first = await insertPublishedOverlay(A.tenantId);
    await setClinicTemplate(first.templateId);
    const original = await finalized(doctor(), patientId);
    const later = await insertPublishedOverlay(A.tenantId);
    await setClinicTemplate(later.templateId);
    const amended = await amendPrescription(doctor(), { prescriptionId: original, reason: "Dose correction" });
    if (!amended.ok) throw new Error(amended.message);
    expect((await rxRow(amended.value.prescriptionId)).row.templateVersionId).toBeNull();
    const [draft] = await adminDb.select({ revision: prescriptions.draftRevision }).from(prescriptions).where(eq(prescriptions.id, amended.value.prescriptionId));
    expect((await finalizePrescription(doctor(), amended.value.prescriptionId, { expectedRevision: draft.revision })).ok).toBe(true);
    expect((await rxRow(amended.value.prescriptionId)).row.templateVersionId).toBe(later.versionId);
    expect((await rxRow(original)).row.templateVersionId).toBe(first.versionId);
  });

  it("a repeat starts as a draft without a template version", async () => {
    const t = await insertPublishedOverlay(A.tenantId);
    await setClinicTemplate(t.templateId);
    const source = await finalized(doctor(), patientId);
    const repeated = await repeatPrescription(doctor(), source);
    if (!repeated.ok) throw new Error(repeated.message);
    expect((await rxRow(repeated.value.prescriptionId)).row.templateVersionId).toBeNull();
  });
});

describe("a finalized record keeps its pad", () => {
  it("is not affected by a later edit of the template (the version, its file and its hash are frozen)", async () => {
    const t = await insertPublishedOverlay(A.tenantId);
    await setClinicTemplate(t.templateId);
    const id = await finalized(doctor(), patientId);
    const before = await rxRow(id);
    await publishNewVersion(A.tenantId, t.templateId, { definition: defaultOverlayDefinition("A4") });
    const after = await rxRow(id);
    expect(after.row.templateVersionId).toBe(t.versionId);
    expect(after.snap).toEqual(before.snap);
  });
});
