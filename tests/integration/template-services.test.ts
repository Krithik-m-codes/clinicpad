// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { adminDb } from "@/server/db/admin";
import { auditEvents, clinics, doctors, prescriptions, templates, templateVersions } from "@/server/db/schema";
import { newId } from "@/lib/domain/ids";
import type { ServiceContext } from "@/server/services/context";
import { finalizePrescription, saveDraft, startPrescription } from "@/server/services/prescriptions";
import { loadRxDocument } from "@/server/services/rx-documents";
import { assignTemplate } from "@/server/services/template-assign";
import { publishTemplate, rollbackTemplate } from "@/server/services/template-publish";
import {
  archiveTemplate,
  createOverlayTemplate,
  discardTemplateDraft,
  getTemplateEditor,
  listTemplates,
  saveTemplateDraft,
  startTemplateDraft,
  unarchiveTemplate,
} from "@/server/services/templates";
import { TEMPLATE_QUOTAS } from "@/server/services/template-files";
import { newPatient, savedDraft } from "../helpers/rx-flow";
import { insertBackgroundFile, insertTemplate, MINIMAL_OVERLAY_DEFINITION } from "../helpers/templates";
import { createTestTenant, type TestTenant } from "../helpers/tenant";

let A: TestTenant;
let B: TestTenant;
let fileA = "";
let doctorA = "";
let doctorOther = "";
const owner = () => A.as("owner");
const designer = (): ServiceContext => ({ tenantId: A.tenantId, userId: newId(), role: "designer" });
const def = () => structuredClone(MINIMAL_OVERLAY_DEFINITION) as typeof MINIMAL_OVERLAY_DEFINITION & Record<string, unknown>;
const publishInput = (baseRevision: number) => ({ identity: "dynamic", boundDoctorId: null, confirmLetterhead: false, acknowledgedOmitted: [], baseRevision });
const boundInput = (doctorId: string, baseRevision = 0) => ({ identity: "bound", boundDoctorId: doctorId, confirmLetterhead: true, acknowledgedOmitted: [], baseRevision });
const newInput = (definition: unknown = def()) => ({ name: "Dr Shah's pad", fileId: fileA, paperSize: "A4", labels: "en", definition });

async function created(ctx: ServiceContext = owner(), definition: unknown = def()) {
  const result = await createOverlayTemplate(ctx, newInput(definition));
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  return result.value;
}
async function published() {
  const t = await created();
  const done = await publishTemplate(owner(), t.templateId, publishInput(0));
  if (!done.ok) throw new Error(done.message);
  return { ...t, ...done.value };
}
async function version(id: string) {
  const [row] = await adminDb.select().from(templateVersions).where(eq(templateVersions.id, id));
  return row;
}

beforeAll(async () => {
  A = await createTestTenant("tpl-svc-a");
  B = await createTestTenant("tpl-svc-b");
  fileA = await insertBackgroundFile(A.tenantId, "svc-file");
  const [d] = await adminDb.select({ id: doctors.id }).from(doctors).where(eq(doctors.tenantId, A.tenantId)).limit(1);
  doctorA = d.id;
  const [other] = await adminDb.insert(doctors).values({ tenantId: A.tenantId, displayName: "Dr Other" }).returning({ id: doctors.id });
  doctorOther = other.id;
});
afterAll(async () => {
  await A.cleanup();
  await B.cleanup();
});
beforeEach(async () => {
  await adminDb.update(clinics).set({ customTemplateId: null }).where(eq(clinics.tenantId, A.tenantId));
  await adminDb.update(doctors).set({ templateId: null }).where(eq(doctors.tenantId, A.tenantId));
  // Earlier tests' pads must not fill the active-template quota (published pads cannot be deleted).
  await adminDb.update(templates).set({ status: "archived" }).where(eq(templates.tenantId, A.tenantId));
});

describe("omitted sections need an explicit acknowledgement", () => {
  const withoutAdvice = () => ({ ...def(), flow: { ...def().flow, sections: def().flow.sections.filter((k) => k !== "advice") } });

  it("refuses a pad whose designer unticked Advice until the owner acknowledges exactly the omitted list", async () => {
    const t = await created(owner(), withoutAdvice());
    const missing = await publishTemplate(owner(), t.templateId, publishInput(0));
    expect(missing).toMatchObject({ ok: false, code: "invalid", issueCodes: ["omitted_sections"] });
    expect((missing as { message: string }).message).toContain("Advice");
    expect((await version(t.versionId)).state).toBe("draft");
    const wrong = await publishTemplate(owner(), t.templateId, { ...publishInput(0), acknowledgedOmitted: ["followUp"] });
    expect(wrong).toMatchObject({ ok: false, issueCodes: ["omitted_sections"] });
    const extra = await publishTemplate(owner(), t.templateId, { ...publishInput(0), acknowledgedOmitted: ["advice", "followUp"] });
    expect(extra).toMatchObject({ ok: false, issueCodes: ["omitted_sections"] });
    const done = await publishTemplate(owner(), t.templateId, { ...publishInput(0), acknowledgedOmitted: ["advice"] });
    expect(done.ok).toBe(true);
    const [event] = await adminDb.select().from(auditEvents).where(and(eq(auditEvents.entityId, t.templateId), eq(auditEvents.action, "template.published")));
    expect(event.after).toMatchObject({ omittedSections: ["advice"] });
  });

  it("a pad that prints everything needs no acknowledgement, and a missing field is an input error", async () => {
    const t = await created();
    const bad = await publishTemplate(owner(), t.templateId, { identity: "dynamic", boundDoctorId: null, confirmLetterhead: false, baseRevision: 0 });
    expect(bad).toMatchObject({ ok: false, code: "invalid" });
    expect((await publishTemplate(owner(), t.templateId, publishInput(0))).ok).toBe(true);
  });

  it("a finalized record with advice, on a pad that leaves Advice off, reports it as unprinted (designer unticks Advice)", async () => {
    const t = await created(owner(), withoutAdvice());
    expect((await publishTemplate(owner(), t.templateId, { ...publishInput(0), acknowledgedOmitted: ["advice"] })).ok).toBe(true);
    await assignTemplate(owner(), { scope: "clinic", templateId: t.templateId });
    const patientId = await newPatient(A.as("reception"), "Unprinted Patient");
    const doctor = A.as("doctor");
    const started = await startPrescription(doctor, { patientId });
    if (!started.ok) throw new Error(started.message);
    const saved = await saveDraft(doctor, started.value.prescriptionId, { advice: "Rest", items: [{ drugName: "Paracetamol", doseMorning: 1 }] }, { baseRevision: 0 });
    if (!saved.ok) throw new Error(saved.message);
    const empty = await loadRxDocument(owner(), started.value.prescriptionId, { withAssets: false });
    expect(empty).toMatchObject({ ok: true, value: { unprintedSections: ["advice"] } });
    const done = await finalizePrescription(doctor, started.value.prescriptionId, { expectedRevision: saved.value.revision });
    expect(done.ok).toBe(true);
    expect(await loadRxDocument(owner(), started.value.prescriptionId, { withAssets: false })).toMatchObject({ ok: true, value: { unprintedSections: ["advice"] } });
    // The same pad with no advice written has nothing to warn about.
    const other = await startPrescription(doctor, { patientId });
    if (!other.ok) throw new Error(other.message);
    await saveDraft(doctor, other.value.prescriptionId, { items: [{ drugName: "Paracetamol", doseMorning: 1 }] }, { baseRevision: 0 });
    expect(await loadRxDocument(owner(), other.value.prescriptionId, { withAssets: false })).toMatchObject({ ok: true, value: { unprintedSections: [] } });
  });

  it("an equivalent box covers the section (no acknowledgement needed)", async () => {
    const d = { ...withoutAdvice(), boxes: [...def().boxes, { id: "adv", field: "advice", xMm: 20, yMm: 70, wMm: 60, hMm: 7, fontPt: 10, align: "left", bold: false, repeat: "every_page" }] };
    const t = await created(owner(), d);
    expect((await publishTemplate(owner(), t.templateId, publishInput(0))).ok).toBe(true);
  });
});

describe("creating and editing drafts", () => {
  it("creates a template with a version-1 draft and audits ids only (never the name)", async () => {
    const t = await created();
    expect(await version(t.versionId)).toMatchObject({ version: 1, state: "draft", paperSize: "A4", labels: "en", draftRevision: 0, identity: "dynamic", boundDoctorId: null, boundConfirmed: false });
    const [event] = await adminDb.select().from(auditEvents).where(and(eq(auditEvents.entityId, t.templateId), eq(auditEvents.action, "template.created")));
    expect(JSON.stringify(event.after)).not.toContain("Shah");
  });

  it("binds a doctor's new draft to the doctor, lets a designer create, refuses reception and a doctor without a profile", async () => {
    const mine = await created(A.as("doctor"));
    expect(await version(mine.versionId)).toMatchObject({ identity: "bound", boundDoctorId: doctorA, boundConfirmed: false });
    expect((await createOverlayTemplate(designer(), newInput())).ok).toBe(true);
    expect(await createOverlayTemplate(A.as("reception"), newInput())).toMatchObject({ ok: false, code: "forbidden" });
    expect(await createOverlayTemplate({ tenantId: A.tenantId, userId: newId(), role: "doctor" }, newInput())).toMatchObject({ ok: false, code: "forbidden" });
  });

  it("refuses another clinic's file, a definition that does not fit the paper, and a NUL in the name", async () => {
    const foreign = await insertBackgroundFile(B.tenantId, "svc-foreign");
    expect(await createOverlayTemplate(owner(), { ...newInput(), fileId: foreign })).toMatchObject({ ok: false, code: "not_found" });
    expect(await createOverlayTemplate(owner(), { ...newInput(), paperSize: "A5" })).toMatchObject({ ok: false, code: "invalid", field: "definition" });
    expect(await createOverlayTemplate(owner(), { ...newInput(), name: "A\u0000B" })).toMatchObject({ ok: false, code: "invalid", field: "name" });
    expect(await createOverlayTemplate(owner(), { ...newInput(), fileId: "not-a-uuid" })).toMatchObject({ ok: false, code: "invalid", field: "fileId" });
  });

  it("saves a draft with a revision check: of two saves from one revision, the second conflicts", async () => {
    const t = await created();
    const changed = { ...def(), printOffsetMm: { x: 1, y: 1 } };
    expect(await saveTemplateDraft(owner(), t.templateId, { definition: changed, labels: "hi", baseRevision: 0 })).toEqual({ ok: true, value: { revision: 1 } });
    expect(await saveTemplateDraft(owner(), t.templateId, { definition: def(), labels: "en", baseRevision: 0 })).toMatchObject({ ok: false, code: "conflict", currentRevision: 1 });
  });

  it("refuses a draft image from another clinic and one that does not exist", async () => {
    const t = await created();
    const foreign = await insertBackgroundFile(B.tenantId, "svc-foreign-save");
    for (const fileId of [foreign, newId()]) {
      expect(await saveTemplateDraft(owner(), t.templateId, { definition: def(), labels: "en", fileId, baseRevision: 0 })).toMatchObject({ ok: false, code: "not_found", field: "fileId" });
    }
  });

  it("lets a doctor edit only templates bound to them", async () => {
    const dynamic = await created();
    expect(await saveTemplateDraft(A.as("doctor"), dynamic.templateId, { definition: def(), labels: "en", baseRevision: 0 })).toMatchObject({ ok: false, code: "forbidden" });
    expect(await startTemplateDraft(A.as("doctor"), dynamic.templateId)).toMatchObject({ ok: false, code: "forbidden" });
    expect(await discardTemplateDraft(A.as("doctor"), dynamic.templateId)).toMatchObject({ ok: false, code: "forbidden" });
    const mine = await created(A.as("doctor"));
    expect((await saveTemplateDraft(A.as("doctor"), mine.templateId, { definition: def(), labels: "en", baseRevision: 0 })).ok).toBe(true);
  });

  it("answers one uniform not_found for another clinic's ids, on every operation", async () => {
    const t = await published();
    await startTemplateDraft(owner(), t.templateId);
    const ghost = newId();
    const b = B.as("owner");
    const calls: Array<(id: string) => Promise<{ ok: boolean; code?: string; message?: string }>> = [
      (id) => getTemplateEditor(b, id),
      (id) => saveTemplateDraft(b, id, { definition: def(), labels: "en", baseRevision: 0 }),
      (id) => startTemplateDraft(b, id),
      (id) => discardTemplateDraft(b, id),
      (id) => publishTemplate(b, id, publishInput(0)),
      (id) => rollbackTemplate(b, id, t.versionId),
      (id) => archiveTemplate(b, id),
      (id) => unarchiveTemplate(b, id),
      (id) => assignTemplate(b, { scope: "clinic", templateId: id }),
    ];
    for (const call of calls) {
      const foreign = await call(t.templateId);
      const missing = await call(ghost);
      expect(foreign).toMatchObject({ ok: false, code: "not_found" });
      expect(foreign).toEqual(missing);
    }
    expect(await listTemplates(b)).toEqual({ ok: true, value: [] });
    expect((await adminDb.select().from(templates).where(eq(templates.id, t.templateId)))[0].status).toBe("active");
  });

  it("keeps the active-template quota exact, also under concurrent creates", async () => {
    const C = await createTestTenant("tpl-svc-quota");
    try {
      const file = await insertBackgroundFile(C.tenantId, "quota-file");
      for (let i = 0; i < TEMPLATE_QUOTAS.activeTemplates - 1; i += 1) await insertTemplate(C.tenantId, { fileId: file });
      const attempts = await Promise.all([1, 2, 3].map(() => createOverlayTemplate(C.as("owner"), { ...newInput(), name: "Last slot", fileId: file })));
      expect(attempts.filter((r) => r.ok)).toHaveLength(1);
      expect(attempts.filter((r) => !r.ok)).toEqual(expect.arrayContaining([expect.objectContaining({ code: "invalid" })]));
      expect(await createOverlayTemplate(C.as("owner"), { ...newInput(), fileId: file })).toMatchObject({ ok: false, code: "invalid" });
    } finally {
      await C.cleanup();
    }
  });
});

describe("publishing", () => {
  it("freezes the draft with its binding, makes it current, and audits the hash and the identity choice", async () => {
    const t = await published();
    expect(await version(t.versionId)).toMatchObject({ state: "published", contentSha256: t.contentSha256, identity: "dynamic", boundDoctorId: null, boundConfirmed: false, publishedBy: owner().userId });
    const [row] = await adminDb.select().from(templates).where(eq(templates.id, t.templateId));
    expect(row.currentVersionId).toBe(t.versionId);
    const [event] = await adminDb.select().from(auditEvents).where(and(eq(auditEvents.entityId, t.templateId), eq(auditEvents.action, "template.published")));
    expect(event.after).toMatchObject({ versionId: t.versionId, version: 1, contentSha256: t.contentSha256, kind: "overlay", identity: "dynamic", fieldCount: 2 });
  });

  it("publishes a bound pad with the binding and confirmation on the version, in the publishing update", async () => {
    const t = await created(A.as("doctor"));
    const done = await publishTemplate(owner(), t.templateId, boundInput(doctorA));
    expect(done.ok).toBe(true);
    expect(await version(t.versionId)).toMatchObject({ state: "published", identity: "bound", boundDoctorId: doctorA, boundConfirmed: true });
  });

  it("publishes exactly once on a double-click", async () => {
    const t = await created();
    const results = await Promise.all([publishTemplate(owner(), t.templateId, publishInput(0)), publishTemplate(owner(), t.templateId, publishInput(0))]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toMatchObject({ code: "conflict" });
  });

  it("refuses doctors and designers, a pad without the patient's name, overlapping boxes (all issues listed), and a bound pad without confirmation", async () => {
    const t = await created();
    expect(await publishTemplate(A.as("doctor"), t.templateId, publishInput(0))).toMatchObject({ ok: false, code: "forbidden" });
    expect(await publishTemplate(designer(), t.templateId, publishInput(0))).toMatchObject({ ok: false, code: "forbidden" });
    const bare = await created(owner(), { ...def(), boxes: [def().boxes[1]] });
    expect(await publishTemplate(owner(), bare.templateId, publishInput(0))).toMatchObject({ ok: false, code: "invalid", field: "definition", issueCodes: ["missing_patient_name"] });
    const overlapping = await created(owner(), { ...def(), boxes: [def().boxes[0], { ...def().boxes[1], id: "b3", xMm: 30, yMm: 52, wMm: 40 }] });
    expect(await publishTemplate(owner(), overlapping.templateId, publishInput(0))).toMatchObject({ ok: false, code: "invalid", issueCodes: ["box_overlap"] });
    expect(await publishTemplate(owner(), t.templateId, { identity: "bound", boundDoctorId: doctorA, confirmLetterhead: false, acknowledgedOmitted: [], baseRevision: 0 })).toMatchObject({ ok: false, code: "invalid", issueCodes: ["bound_confirmation"] });
    expect(await publishTemplate(owner(), t.templateId, { identity: "bound", boundDoctorId: null, confirmLetterhead: true, acknowledgedOmitted: [], baseRevision: 0 })).toMatchObject({ ok: false, code: "invalid", issueCodes: ["bound_doctor"] });
    expect(await publishTemplate(owner(), t.templateId, boundInput(newId()))).toMatchObject({ ok: false, code: "invalid", field: "boundDoctorId" });
    expect((await version(t.versionId)).state).toBe("draft");
  });

  it("refuses a stale base revision", async () => {
    const t = await created();
    await saveTemplateDraft(owner(), t.templateId, { definition: def(), labels: "en", baseRevision: 0 });
    expect(await publishTemplate(owner(), t.templateId, publishInput(0))).toMatchObject({ ok: false, code: "conflict" });
  });

  it("refuses to publish a pad as bound while it is the clinic default or another doctor's pad", async () => {
    const t = await published();
    await assignTemplate(owner(), { scope: "clinic", templateId: t.templateId });
    await startTemplateDraft(owner(), t.templateId);
    expect(await publishTemplate(owner(), t.templateId, boundInput(doctorA))).toMatchObject({ ok: false, code: "conflict" });
    await assignTemplate(owner(), { scope: "clinic", templateId: null });
    await assignTemplate(owner(), { scope: "doctor", doctorId: doctorOther, templateId: t.templateId });
    expect(await publishTemplate(owner(), t.templateId, boundInput(doctorA))).toMatchObject({ ok: false, code: "conflict" });
    expect(await publishTemplate(owner(), t.templateId, boundInput(doctorOther))).toMatchObject({ ok: true });
  });

  it("starts a new draft from the published version with its binding (idempotently), and rolls back by publishing a copy", async () => {
    const t = await published();
    const first = await startTemplateDraft(owner(), t.templateId);
    const again = await startTemplateDraft(owner(), t.templateId);
    expect(first.ok && again.ok && first.value.versionId === again.value.versionId && first.value.version === 2).toBe(true);
    expect(await rollbackTemplate(owner(), t.templateId, t.versionId)).toMatchObject({ ok: false, code: "conflict" });
    expect((await discardTemplateDraft(owner(), t.templateId)).ok).toBe(true);
    const rolled = await rollbackTemplate(owner(), t.templateId, t.versionId);
    expect(rolled).toMatchObject({ ok: true, value: { version: 2 } });
    if (!rolled.ok) return;
    expect(await version(rolled.value.versionId)).toMatchObject({ state: "published", contentSha256: t.contentSha256, publishedBy: owner().userId });
  });

  it("a bound pad's next draft stays bound to the same doctor, who may keep editing it", async () => {
    const t = await created(A.as("doctor"));
    await publishTemplate(owner(), t.templateId, boundInput(doctorA));
    const next = await startTemplateDraft(A.as("doctor"), t.templateId);
    expect(next.ok).toBe(true);
    if (!next.ok) return;
    expect(await version(next.value.versionId)).toMatchObject({ identity: "bound", boundDoctorId: doctorA, boundConfirmed: false });
  });

  it("deletes a never-published template when its only draft is discarded", async () => {
    const t = await created();
    expect(await discardTemplateDraft(owner(), t.templateId)).toEqual({ ok: true, value: { templateDeleted: true } });
    expect(await adminDb.select().from(templates).where(eq(templates.id, t.templateId))).toHaveLength(0);
  });
});

describe("rollback binding (per version)", () => {
  async function boundThenUnbound() {
    const t = await created(A.as("doctor"));
    const v1 = await publishTemplate(owner(), t.templateId, boundInput(doctorA));
    if (!v1.ok) throw new Error(v1.message);
    const draft = await startTemplateDraft(owner(), t.templateId);
    if (!draft.ok) throw new Error(draft.message);
    const v2 = await publishTemplate(owner(), t.templateId, publishInput(0));
    if (!v2.ok) throw new Error(v2.message);
    return { templateId: t.templateId, v1: v1.value.versionId, v2: v2.value.versionId };
  }

  it("refuses a rollback to a bound version while the pad is the clinic default", async () => {
    const t = await boundThenUnbound();
    expect(await assignTemplate(owner(), { scope: "clinic", templateId: t.templateId })).toMatchObject({ ok: true });
    expect(await rollbackTemplate(owner(), t.templateId, t.v1)).toMatchObject({ ok: false, code: "conflict" });
    const [row] = await adminDb.select().from(templates).where(eq(templates.id, t.templateId));
    expect(row.currentVersionId).toBe(t.v2);
  });

  it("refuses a rollback to a bound version while another doctor uses the pad, and accepts it once nobody does", async () => {
    const t = await boundThenUnbound();
    await assignTemplate(owner(), { scope: "doctor", doctorId: doctorOther, templateId: t.templateId });
    expect(await rollbackTemplate(owner(), t.templateId, t.v1)).toMatchObject({ ok: false, code: "conflict" });
    await assignTemplate(owner(), { scope: "doctor", doctorId: doctorOther, templateId: null });
    const rolled = await rollbackTemplate(owner(), t.templateId, t.v1);
    expect(rolled.ok).toBe(true);
    if (!rolled.ok) return;
    expect(await version(rolled.value.versionId)).toMatchObject({ identity: "bound", boundDoctorId: doctorA, boundConfirmed: true });
  });

  it("copies an unbound source's binding too (v1 dynamic, v2 bound, rollback gives dynamic again)", async () => {
    const t = await published();
    await startTemplateDraft(owner(), t.templateId);
    await publishTemplate(owner(), t.templateId, boundInput(doctorA));
    const rolled = await rollbackTemplate(owner(), t.templateId, t.versionId);
    expect(rolled.ok).toBe(true);
    if (!rolled.ok) return;
    expect(await version(rolled.value.versionId)).toMatchObject({ identity: "dynamic", boundDoctorId: null, boundConfirmed: false });
  });
});

describe("assigning and archiving", () => {
  it("assigns a dynamic pad to the clinic and a bound pad only to its own doctor (by the current version)", async () => {
    const dynamic = await published();
    expect(await assignTemplate(owner(), { scope: "clinic", templateId: dynamic.templateId })).toEqual({ ok: true, value: { previousTemplateId: null } });
    const bound = await created(A.as("doctor"));
    await publishTemplate(owner(), bound.templateId, boundInput(doctorA));
    expect(await assignTemplate(owner(), { scope: "clinic", templateId: bound.templateId })).toMatchObject({ ok: false, code: "invalid" });
    expect(await assignTemplate(owner(), { scope: "doctor", doctorId: doctorOther, templateId: bound.templateId })).toMatchObject({ ok: false, code: "invalid" });
    expect((await assignTemplate(A.as("doctor"), { scope: "doctor", doctorId: doctorA, templateId: bound.templateId })).ok).toBe(true);
  });

  it("lets a doctor set only their own pad, and nobody assign an unpublished or archived one", async () => {
    const t = await published();
    expect(await assignTemplate(A.as("doctor"), { scope: "doctor", doctorId: doctorOther, templateId: t.templateId })).toMatchObject({ ok: false, code: "forbidden" });
    expect(await assignTemplate(A.as("doctor"), { scope: "clinic", templateId: t.templateId })).toMatchObject({ ok: false, code: "forbidden" });
    expect(await assignTemplate(designer(), { scope: "clinic", templateId: t.templateId })).toMatchObject({ ok: false, code: "forbidden" });
    const draftOnly = await created();
    expect(await assignTemplate(owner(), { scope: "clinic", templateId: draftOnly.templateId })).toMatchObject({ ok: false, code: "conflict" });
    expect((await archiveTemplate(owner(), t.templateId)).ok).toBe(true);
    expect(await assignTemplate(owner(), { scope: "clinic", templateId: t.templateId })).toMatchObject({ ok: false, code: "conflict" });
  });

  it("refuses to archive a pad in use, and an archive racing an assignment never leaves an archived pad assigned", async () => {
    const t = await published();
    await assignTemplate(owner(), { scope: "clinic", templateId: t.templateId });
    expect(await archiveTemplate(owner(), t.templateId)).toMatchObject({ ok: false, code: "conflict" });
    await assignTemplate(owner(), { scope: "clinic", templateId: null });
    const race = await published();
    await Promise.all([archiveTemplate(owner(), race.templateId), assignTemplate(owner(), { scope: "clinic", templateId: race.templateId })]);
    const [row] = await adminDb.select().from(templates).where(eq(templates.id, race.templateId));
    const [clinic] = await adminDb.select().from(clinics).where(eq(clinics.tenantId, A.tenantId));
    expect(row.status === "archived" && clinic.customTemplateId === race.templateId).toBe(false);
  });

  it("a publish as bound racing a clinic assignment never leaves a bound current version as the clinic default", async () => {
    for (let i = 0; i < 3; i += 1) {
      await adminDb.update(clinics).set({ customTemplateId: null }).where(eq(clinics.tenantId, A.tenantId));
      const t = await published();
      await startTemplateDraft(owner(), t.templateId);
      await Promise.all([publishTemplate(owner(), t.templateId, boundInput(doctorA)), assignTemplate(owner(), { scope: "clinic", templateId: t.templateId })]);
      const [row] = await adminDb.select().from(templates).where(eq(templates.id, t.templateId));
      const [clinic] = await adminDb.select().from(clinics).where(eq(clinics.tenantId, A.tenantId));
      const current = await version(row.currentVersionId as string);
      expect(clinic.customTemplateId === t.templateId && current.identity === "bound").toBe(false);
    }
  });

  it("restores an archived pad within the quota", async () => {
    const t = await published();
    await archiveTemplate(owner(), t.templateId);
    expect((await unarchiveTemplate(owner(), t.templateId)).ok).toBe(true);
  });

  it("a finalize racing a publish freezes one of the published versions, never a draft", async () => {
    const t = await published();
    await assignTemplate(owner(), { scope: "clinic", templateId: t.templateId });
    await startTemplateDraft(owner(), t.templateId);
    const { id, revision } = await savedDraft(A.as("doctor"), await newPatient(A.as("reception"), "Race Patient"));
    const [done] = await Promise.all([finalizePrescription(A.as("doctor"), id, { expectedRevision: revision }), publishTemplate(owner(), t.templateId, publishInput(0))]);
    expect(done.ok).toBe(true);
    const [row] = await adminDb.select().from(prescriptions).where(eq(prescriptions.id, id));
    expect((await version(row.templateVersionId as string)).state).toBe("published");
  });
});
