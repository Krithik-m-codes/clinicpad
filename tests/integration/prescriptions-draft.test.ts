import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { withTenant } from "@/server/db/tenant";
import { adminDb } from "@/server/db/admin";
import { auditEvents, doctors, prescriptions, visits } from "@/server/db/schema";
import type { ServiceContext } from "@/server/services/context";
import { archivePatient, createPatient } from "@/server/services/patients";
import {
  getPrescription,
  listPrescriptionsForPatient,
  saveDraft,
  startPrescription,
} from "@/server/services/prescriptions";
import { newId } from "@/lib/domain/ids";
import { createTestTenant, type TestTenant } from "../helpers/tenant";

let A: TestTenant;
let B: TestTenant;
let patientId = "";

const draft = (items: Record<string, unknown>[] = [{ drugName: "Paracetamol", dose: "1 tablet", timing: "TDS", durationDays: 3 }]) => ({
  visitType: "new",
  chiefComplaint: "Fever for 2 days",
  diagnosis: ["Viral fever"],
  advice: "Rest and fluids",
  followUpDate: "2026-12-01",
  items,
});

beforeAll(async () => {
  A = await createTestTenant("rxda");
  B = await createTestTenant("rxdb");
  const p = await createPatient(A.as("reception"), { name: "Draft Patient" });
  if (!p.ok) throw new Error(p.message);
  patientId = p.value.id;
});
afterAll(async () => {
  await A.cleanup();
  await B.cleanup();
});

async function start(ctx = A.as("doctor")) {
  const r = await startPrescription(ctx, { patientId });
  if (!r.ok) throw new Error(r.message);
  return r.value.prescriptionId;
}

describe("startPrescription", () => {
  it("creates an empty draft with no Rx number and an audit event", async () => {
    const id = await start();
    const got = await getPrescription(A.as("doctor"), id);
    expect(got).toMatchObject({
      ok: true,
      value: { status: "draft", version: 1, rxNo: null, items: [], patient: { name: "Draft Patient" } },
    });
    const audit = await withTenant(A.tenantId, (tx) =>
      tx.select().from(auditEvents).where(eq(auditEvents.entityId, id)),
    );
    expect(audit.map((e) => e.action)).toEqual(["prescription.drafted"]);
  });

  it.each(["reception", "nurse", "accountant", "pharmacist"])("forbids %s from starting one", async (role) => {
    expect(await startPrescription(A.as(role), { patientId })).toMatchObject({ ok: false, code: "forbidden" });
  });

  it.each(["owner", "doctor"])("lets %s start a draft", async (role) => {
    const started = await startPrescription(A.as(role), { patientId });
    expect(started.ok).toBe(true);
  });

  it("records the doctor profile of the user as the visit doctor, or null when there is none", async () => {
    const [profile] = await adminDb.select({ id: doctors.id }).from(doctors).where(eq(doctors.tenantId, A.tenantId));
    const visitDoctorId = async (ctx: ServiceContext) => {
      const started = await startPrescription(ctx, { patientId });
      if (!started.ok) throw new Error(started.message);
      const [row] = await adminDb
        .select({ doctorId: visits.doctorId })
        .from(prescriptions)
        .innerJoin(visits, eq(visits.id, prescriptions.visitId))
        .where(eq(prescriptions.id, started.value.prescriptionId));
      return row.doctorId;
    };

    // The test tenant's owner and doctor share one user, and that user has a doctor profile.
    expect(await visitDoctorId(A.as("doctor"))).toBe(profile.id);
    expect(await visitDoctorId(A.as("owner"))).toBe(profile.id);
    // An owner who has no doctor profile can still start and save a draft; the visit has no doctor.
    const profileless: ServiceContext = { ...A.as("owner"), userId: newId() };
    expect(await visitDoctorId(profileless)).toBeNull();
    const id = await startPrescription(profileless, { patientId });
    if (!id.ok) throw new Error(id.message);
    expect((await saveDraft(profileless, id.value.prescriptionId, draft())).ok).toBe(true);
  });

  it("returns not_found for unknown, malformed, other-clinic, and archived patients", async () => {
    expect(await startPrescription(A.as("doctor"), { patientId: newId() })).toMatchObject({ ok: false, code: "not_found" });
    expect(await startPrescription(A.as("doctor"), { patientId: "nope" })).toMatchObject({ ok: false, code: "not_found" });
    const foreign = await createPatient(A.as("owner"), { name: "Only In Clinic A" });
    if (!foreign.ok) throw new Error(foreign.message);
    expect(await startPrescription(B.as("doctor"), { patientId: foreign.value.id })).toMatchObject({
      ok: false,
      code: "not_found",
    });
    // Nothing was written for the foreign patient (checked on the admin connection, which sees every tenant).
    expect(await adminDb.select({ id: visits.id }).from(visits).where(eq(visits.patientId, foreign.value.id))).toEqual([]);

    const gone = await createPatient(A.as("owner"), { name: "Soon Archived" });
    if (!gone.ok) throw new Error(gone.message);
    await archivePatient(A.as("owner"), gone.value.id);
    expect(await startPrescription(A.as("doctor"), { patientId: gone.value.id })).toMatchObject({
      ok: false,
      code: "not_found",
    });
  });
});

describe("saveDraft", () => {
  it("stores visit fields and items in order, and replaces them on the next save", async () => {
    const id = await start();
    const saved = await saveDraft(
      A.as("doctor"),
      id,
      draft([
        { drugName: "Paracetamol", strength: "500 mg", dose: "1 tablet", timing: "TDS", durationDays: 3 },
        { drugName: "Cetirizine", timing: "HS", durationDays: null },
      ]),
    );
    expect(saved.ok).toBe(true);

    const first = await getPrescription(A.as("doctor"), id);
    if (!first.ok) throw new Error(first.message);
    expect(first.value.visit).toMatchObject({
      chiefComplaint: "Fever for 2 days",
      diagnosis: ["Viral fever"],
      followUpDate: "2026-12-01",
    });
    expect(first.value.items.map((i) => i.drugName)).toEqual(["Paracetamol", "Cetirizine"]);
    expect(first.value.items[0]).toMatchObject({ strength: "500 mg", durationDays: 3 });

    await saveDraft(A.as("doctor"), id, draft([{ drugName: "Azithromycin" }]));
    const second = await getPrescription(A.as("doctor"), id);
    expect(second.ok && second.value.items.map((i) => i.drugName)).toEqual(["Azithromycin"]);
  });

  it("allows saving an empty draft and treats blank strings as absent", async () => {
    const id = await start();
    const saved = await saveDraft(A.as("doctor"), id, {
      chiefComplaint: "",
      advice: "",
      followUpDate: "",
      items: [{ drugName: "Paracetamol", strength: "", dose: "", durationDays: null }],
    });
    expect(saved.ok).toBe(true);
    const got = await getPrescription(A.as("doctor"), id);
    expect(got.ok && got.value.items[0].strength).toBeNull();
  });

  it.each([
    [{ items: [{ drugName: "" }] }, "items"],
    [{ items: [{ drugName: "X", durationDays: 0 }] }, "items"],
    [{ items: [{ drugName: "X", durationDays: 1000 }] }, "items"],
    [{ items: Array.from({ length: 31 }, () => ({ drugName: "X" })) }, "items"],
    [{ followUpDate: "tomorrow" }, "followUpDate"],
    [{ visitType: "surgery" }, "visitType"],
  ])("rejects invalid input %j", async (input, field) => {
    const id = await start();
    expect(await saveDraft(A.as("doctor"), id, input)).toMatchObject({ ok: false, code: "invalid", field });
  });

  describe("a NUL character in free text", () => {
    // Written as an escape so the source file holds no invisible character; the next test proves it is one code point.
    const NUL = "\u0000";

    it("is a single code point", () => {
      expect([...NUL]).toHaveLength(1);
      expect(NUL.codePointAt(0)).toBe(0);
      expect(`a${NUL}b`).toHaveLength(3);
    });

    it.each([
      ["drugName", "items", (v: string) => ({ items: [{ drugName: v }] })],
      ["strength", "items", (v: string) => ({ items: [{ drugName: "X", strength: v }] })],
      ["form", "items", (v: string) => ({ items: [{ drugName: "X", form: v }] })],
      ["route", "items", (v: string) => ({ items: [{ drugName: "X", route: v }] })],
      ["dose", "items", (v: string) => ({ items: [{ drugName: "X", dose: v }] })],
      ["timing", "items", (v: string) => ({ items: [{ drugName: "X", timing: v }] })],
      ["foodRelation", "items", (v: string) => ({ items: [{ drugName: "X", foodRelation: v }] })],
      ["remarks", "items", (v: string) => ({ items: [{ drugName: "X", remarks: v }] })],
      ["chiefComplaint", "chiefComplaint", (v: string) => ({ chiefComplaint: v })],
      ["diagnosis entry", "diagnosis", (v: string) => ({ diagnosis: ["Fine", v] })],
      ["advice", "advice", (v: string) => ({ advice: v })],
    ])("is refused in %s as invalid and writes nothing", async (_name, field, build) => {
      const id = await start();
      expect((await saveDraft(A.as("doctor"), id, draft([{ drugName: "Original" }]))).ok).toBe(true);

      const result = await saveDraft(A.as("doctor"), id, build(`bad${NUL}text`));
      expect(result).toMatchObject({ ok: false, code: "invalid", field });

      const got = await getPrescription(A.as("doctor"), id);
      if (!got.ok) throw new Error(got.message);
      expect(got.value.items.map((i) => i.drugName)).toEqual(["Original"]);
      expect(got.value.visit).toMatchObject({ chiefComplaint: "Fever for 2 days", advice: "Rest and fluids" });
    });
  });

  describe("follow-up date range", () => {
    it.each(["0000-01-01", "1899-12-31", "2101-01-01", "2026-02-30"])("refuses %s as invalid and writes nothing", async (date) => {
      const id = await start();
      expect((await saveDraft(A.as("doctor"), id, draft())).ok).toBe(true);
      expect(await saveDraft(A.as("doctor"), id, { ...draft([{ drugName: "Changed" }]), followUpDate: date })).toMatchObject({
        ok: false,
        code: "invalid",
        field: "followUpDate",
      });
      const got = await getPrescription(A.as("doctor"), id);
      expect(got.ok && got.value.visit.followUpDate).toBe("2026-12-01");
      expect(got.ok && got.value.items.map((i) => i.drugName)).toEqual(["Paracetamol"]);
    });

    it.each(["1900-01-01", "2026-12-01", "2100-12-31"])("accepts %s", async (date) => {
      const id = await start();
      expect((await saveDraft(A.as("doctor"), id, { ...draft(), followUpDate: date })).ok).toBe(true);
      const got = await getPrescription(A.as("doctor"), id);
      expect(got.ok && got.value.visit.followUpDate).toBe(date);
    });
  });

  it("refuses a finalized prescription as immutable and leaves it untouched", async () => {
    const id = await start();
    await saveDraft(A.as("doctor"), id, draft());
    await adminDb.update(prescriptions).set({ status: "finalized", finalizedAt: new Date() }).where(eq(prescriptions.id, id));

    expect(await saveDraft(A.as("doctor"), id, draft([{ drugName: "Changed" }]))).toMatchObject({
      ok: false,
      code: "immutable",
    });
    const got = await getPrescription(A.as("doctor"), id);
    expect(got.ok && got.value.items.map((i) => i.drugName)).toEqual(["Paracetamol"]);
  });

  it("maps the database immutability error (SQLSTATE 23000) to immutable", async () => {
    const id = await start();
    // A draft prescription whose visit is already finalized: the service status check passes,
    // and the database trigger refuses the visit update.
    const [rx] = await adminDb.select({ visitId: prescriptions.visitId }).from(prescriptions).where(eq(prescriptions.id, id));
    await adminDb.update(visits).set({ status: "finalized", finalizedAt: new Date() }).where(eq(visits.id, rx.visitId));

    expect(await saveDraft(A.as("doctor"), id, draft())).toMatchObject({ ok: false, code: "immutable" });
  });

  it.each(["reception", "nurse", "accountant", "pharmacist"])("forbids %s from saving a draft", async (role) => {
    const id = await start();
    expect(await saveDraft(A.as(role), id, draft())).toMatchObject({ ok: false, code: "forbidden" });
    const got = await getPrescription(A.as("doctor"), id);
    expect(got.ok && got.value.items).toEqual([]);
  });

  it.each(["owner", "doctor"])("lets %s save a draft", async (role) => {
    const id = await start();
    expect((await saveDraft(A.as(role), id, draft())).ok).toBe(true);
  });

  it("hides other clinics' drafts, and treats malformed and unknown ids as not found", async () => {
    const id = await start();
    expect(await saveDraft(B.as("doctor"), id, draft())).toMatchObject({ ok: false, code: "not_found" });
    expect(await saveDraft(A.as("doctor"), "not-a-uuid", draft())).toMatchObject({ ok: false, code: "not_found" });
    expect(await saveDraft(A.as("doctor"), newId(), draft())).toMatchObject({ ok: false, code: "not_found" });
  });
});

describe("getPrescription", () => {
  it.each(["owner", "doctor", "reception", "nurse", "pharmacist"])("lets %s read", async (role) => {
    const id = await start();
    expect((await getPrescription(A.as(role), id)).ok).toBe(true);
  });

  it("denies accountants", async () => {
    const id = await start();
    expect(await getPrescription(A.as("accountant"), id)).toMatchObject({ ok: false, code: "forbidden" });
  });

  it("carries the patient's allergies, as an empty array when there are none", async () => {
    const none = await start();
    const withNone = await getPrescription(A.as("doctor"), none);
    expect(withNone.ok && withNone.value.patient.allergies).toEqual([]);

    const allergic = await createPatient(A.as("reception"), { name: "Allergic Patient", allergies: ["Penicillin", "Sulfa"] });
    if (!allergic.ok) throw new Error(allergic.message);
    const started = await startPrescription(A.as("doctor"), { patientId: allergic.value.id });
    if (!started.ok) throw new Error(started.message);
    const rxId = started.value.prescriptionId;

    for (const role of ["owner", "doctor", "reception", "nurse", "pharmacist"]) {
      const got = await getPrescription(A.as(role), rxId);
      expect(got.ok && got.value.patient.allergies).toEqual(["Penicillin", "Sulfa"]);
    }
  });

  it("hides other clinics' records, and treats malformed and unknown ids as not found", async () => {
    const id = await start();
    expect(await getPrescription(B.as("owner"), id)).toMatchObject({ ok: false, code: "not_found" });
    expect(await getPrescription(A.as("owner"), "x")).toMatchObject({ ok: false, code: "not_found" });
    expect(await getPrescription(A.as("owner"), newId())).toMatchObject({ ok: false, code: "not_found" });
  });
});

describe("listPrescriptionsForPatient", () => {
  it("lists a patient's prescriptions newest first and hides other clinics", async () => {
    const p = await createPatient(A.as("owner"), { name: "List Patient" });
    if (!p.ok) throw new Error(p.message);
    const a = await startPrescription(A.as("doctor"), { patientId: p.value.id });
    const b = await startPrescription(A.as("doctor"), { patientId: p.value.id });
    if (!a.ok || !b.ok) throw new Error("setup failed");

    const list = await listPrescriptionsForPatient(A.as("reception"), p.value.id);
    expect(list.ok && list.value.map((r) => r.id)).toEqual([b.value.prescriptionId, a.value.prescriptionId]);
    expect(await listPrescriptionsForPatient(B.as("owner"), p.value.id)).toMatchObject({ ok: false, code: "not_found" });
    expect(await listPrescriptionsForPatient(A.as("accountant"), p.value.id)).toMatchObject({ ok: false, code: "forbidden" });
  });

  it.each(["owner", "doctor", "reception", "nurse", "pharmacist"])("lets %s list", async (role) => {
    expect((await listPrescriptionsForPatient(A.as(role), patientId)).ok).toBe(true);
  });

  it("treats malformed and unknown patient ids as not found", async () => {
    expect(await listPrescriptionsForPatient(A.as("owner"), "nope")).toMatchObject({ ok: false, code: "not_found" });
    expect(await listPrescriptionsForPatient(A.as("owner"), newId())).toMatchObject({ ok: false, code: "not_found" });
  });
});
