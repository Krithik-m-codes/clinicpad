import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { adminDb } from "@/server/db/admin";
import { withTenant } from "@/server/db/tenant";
import { auditEvents, tenantCounters } from "@/server/db/schema";
import { createPatient } from "@/server/services/patients";
import {
  amendPrescription,
  finalizePrescription,
  getPrescription,
  repeatPrescription,
  saveDraft,
  startPrescription,
} from "@/server/services/prescriptions";
import { createTestTenant, type TestTenant } from "../helpers/tenant";

let A: TestTenant;
let patientId = "";
const doctor = () => A.as("doctor");
const secret = `SECRET${Date.now()}`;

const clinicalDraft = () => ({
  visitType: "new",
  chiefComplaint: `${secret}-chief`,
  complaints: [`${secret}-complaint`, "Cough"],
  diagnosis: ["Viral fever"],
  medicalHistory: [`${secret}-history`],
  drugHistory: ["Metformin"],
  examinationNotes: `${secret}-exam`,
  vitals: { pulse: 96, spo2: 98, bpSystolic: 128, bpDiastolic: 84, notes: `${secret}-vitals` },
  investigations: [{ name: "CBC", instructions: `${secret}-instructions` }, { name: "CRP" }],
  advice: `${secret}-advice`,
  followUpDate: "2026-12-10",
  followUpReason: `${secret}-reason`,
  items: [
    {
      drugName: "DOLO 650MG",
      genericName: "Paracetamol 650Mg",
      doseMorning: 1,
      doseAfternoon: 0,
      doseNight: 1,
      foodRelation: "after",
      periodicity: "daily",
      durationValue: 5,
      durationUnit: "days",
      remarks: `${secret}-remarks`,
    },
    { drugName: "Levocetirizine", doseNight: 1, isSos: true, timing: "if itching", durationValue: 1, durationUnit: "weeks" },
  ],
});

beforeAll(async () => {
  A = await createTestTenant("clla");
  const p = await createPatient(A.as("reception"), { name: "Lifecycle Clinical Patient" });
  if (!p.ok) throw new Error(p.message);
  patientId = p.value.id;
});

afterAll(async () => {
  await A.cleanup();
});

/** Draft saved once (revision 1) with the full clinical form. */
async function savedDraft(): Promise<string> {
  const s = await startPrescription(doctor(), { patientId });
  if (!s.ok) throw new Error(s.message);
  const saved = await saveDraft(doctor(), s.value.prescriptionId, clinicalDraft(), { baseRevision: 0 });
  if (!saved.ok) throw new Error(saved.message);
  return s.value.prescriptionId;
}

async function finalized(): Promise<string> {
  const id = await savedDraft();
  const done = await finalizePrescription(doctor(), id, { expectedRevision: 1 });
  if (!done.ok) throw new Error(done.message);
  return id;
}

async function read(id: string) {
  const got = await getPrescription(doctor(), id);
  if (!got.ok) throw new Error(got.message);
  return got.value;
}

async function auditFor(entityId: string) {
  return withTenant(A.tenantId, (tx) => tx.select().from(auditEvents).where(eq(auditEvents.entityId, entityId)));
}

describe("finalizePrescription with revisions", () => {
  it("refuses to finalize a revision the doctor did not see, without burning a number", async () => {
    const id = await savedDraft();
    const before = await adminDb.select().from(tenantCounters).where(eq(tenantCounters.tenantId, A.tenantId));
    const beforeRx = before.find((c) => c.name === "rx")?.lastNo ?? 0;

    expect(await finalizePrescription(doctor(), id, { expectedRevision: 0 })).toMatchObject({ ok: false, code: "conflict" });
    expect((await read(id)).status).toBe("draft");
    const after = await adminDb.select().from(tenantCounters).where(eq(tenantCounters.tenantId, A.tenantId));
    expect(after.find((c) => c.name === "rx")?.lastNo ?? 0).toBe(beforeRx);

    expect(await finalizePrescription(doctor(), id, { expectedRevision: 1 })).toMatchObject({ ok: true });
  });

  it("still finalizes without an expected revision (Plan 1A callers)", async () => {
    const id = await savedDraft();
    expect((await finalizePrescription(doctor(), id)).ok).toBe(true);
  });

  it("audits counts and field names, never the clinical text", async () => {
    const id = await finalized();
    const event = (await auditFor(id)).find((e) => e.action === "prescription.finalized");
    expect(event?.after).toMatchObject({
      version: 1,
      itemCount: 2,
      diagnosisCount: 1,
      investigationCount: 2,
      vitalsRecorded: ["bpDiastolic", "bpSystolic", "pulse", "spo2"],
    });
    expect((event?.after as { filledFields: string[] }).filledFields).toEqual(
      expect.arrayContaining([
        "chiefComplaint",
        "complaints",
        "diagnosis",
        "medicalHistory",
        "drugHistory",
        "examinationNotes",
        "vitals",
        "investigations",
        "advice",
        "followUpDate",
        "followUpReason",
      ]),
    );
    expect(JSON.stringify(event)).not.toContain(secret);
  });
});

describe("amendPrescription copies the whole clinical record", () => {
  it("copies every visit field and every item column into the new version", async () => {
    const id = await finalized();
    const amended = await amendPrescription(doctor(), { prescriptionId: id, reason: "Wrong duration" });
    if (!amended.ok) throw new Error(amended.message);

    const v1 = await read(id);
    const v2 = await read(amended.value.prescriptionId);
    expect(v2.status).toBe("draft");
    expect(v2.revision).toBe(0);
    expect(v2.visit).toEqual({ ...v1.visit, id: v2.visit.id });
    expect(v2.items).toEqual(v1.items);
  });

  it("keeps the reason on the prescription but out of the audit log (Plan 1A payload unchanged)", async () => {
    const id = await finalized();
    const reason = `Patient reported a rash ${secret}`;
    const amended = await amendPrescription(doctor(), { prescriptionId: id, reason });
    if (!amended.ok) throw new Error(amended.message);

    expect((await read(amended.value.prescriptionId)).amendmentReason).toBe(reason);
    const event = (await auditFor(amended.value.prescriptionId)).find((e) => e.action === "prescription.amendment_drafted");
    expect(event?.after).toEqual({ version: 2, parentPrescriptionId: id, reasonLength: reason.length });
    expect(JSON.stringify(event)).not.toContain(secret);
  });

  it("finalizing the amendment audits the same summary shape plus the parent id", async () => {
    const id = await finalized();
    const amended = await amendPrescription(doctor(), { prescriptionId: id, reason: "Add a test" });
    if (!amended.ok) throw new Error(amended.message);
    const done = await finalizePrescription(doctor(), amended.value.prescriptionId, { expectedRevision: 0 });
    expect(done).toMatchObject({ ok: true, value: { version: 2 } });
    const event = (await auditFor(amended.value.prescriptionId)).find((e) => e.action === "prescription.amended");
    expect(event?.after).toMatchObject({ version: 2, parentPrescriptionId: id, itemCount: 2, investigationCount: 2 });
    expect(JSON.stringify(event)).not.toContain(secret);
  });
});

describe("repeatPrescription", () => {
  it("copies the prescribing content but not the old visit's measurements", async () => {
    const id = await finalized();
    const repeated = await repeatPrescription(doctor(), id);
    if (!repeated.ok) throw new Error(repeated.message);

    const original = await read(id);
    const copy = await read(repeated.value.prescriptionId);
    expect(copy.items).toEqual(original.items);
    expect(copy.visit).toMatchObject({
      visitType: "follow-up",
      chiefComplaint: original.visit.chiefComplaint,
      complaints: original.visit.complaints,
      diagnosis: original.visit.diagnosis,
      medicalHistory: original.visit.medicalHistory,
      drugHistory: original.visit.drugHistory,
      investigations: original.visit.investigations,
      advice: original.visit.advice,
      vitals: {},
      examinationNotes: null,
      followUpDate: null,
      followUpReason: null,
    });
  });

  it("repeats only the latest version, with that version's clinical content", async () => {
    const id = await finalized();
    const amended = await amendPrescription(doctor(), { prescriptionId: id, reason: "Correct the complaints" });
    if (!amended.ok) throw new Error(amended.message);
    const v2Id = amended.value.prescriptionId;
    const saved = await saveDraft(doctor(), v2Id, { ...clinicalDraft(), complaints: ["Corrected complaint"] }, { baseRevision: 0 });
    if (!saved.ok) throw new Error(saved.message);
    expect(await finalizePrescription(doctor(), v2Id, { expectedRevision: 1 })).toMatchObject({ ok: true });

    // Plan 1A's rule: the superseded v1 is refused.
    expect(await repeatPrescription(doctor(), id)).toMatchObject({ ok: false, code: "conflict" });
    const repeated = await repeatPrescription(doctor(), v2Id);
    if (!repeated.ok) throw new Error(repeated.message);
    expect((await read(repeated.value.prescriptionId)).visit.complaints).toEqual(["Corrected complaint"]);
  });
});
