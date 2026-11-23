import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { adminDb } from "@/server/db/admin";
import { clinics, doctors, patients, prescriptions, visits } from "@/server/db/schema";
import { createPatient } from "@/server/services/patients";
import { amendPrescription, startPrescription } from "@/server/services/prescriptions";
import { HISTORY_PAGE_SIZE, listPatientPrescriptions, parseHistoryFilters } from "@/server/services/patient-history";
import { finalizeNow, saveDraftNow } from "../helpers/rx";
import { createTestTenant, type TestTenant } from "../helpers/tenant";

let A: TestTenant;
let B: TestTenant;
let patientId = "";
let secondDoctorId = "";
const ids: Record<"fever" | "migraine" | "superseded" | "current" | "other", string> = {
  fever: "",
  migraine: "",
  superseded: "",
  current: "",
  other: "",
};

async function draft(content: Record<string, unknown>): Promise<string> {
  const started = await startPrescription(A.as("doctor"), { patientId });
  if (!started.ok) throw new Error(started.message);
  const saved = await saveDraftNow(A.as("doctor"), started.value.prescriptionId, content);
  if (!saved.ok) throw new Error(saved.message);
  return started.value.prescriptionId;
}

async function finalized(content: Record<string, unknown>): Promise<string> {
  const id = await draft(content);
  const done = await finalizeNow(A.as("doctor"), id);
  if (!done.ok) throw new Error(done.message);
  return id;
}

const list = (raw: unknown = {}, role = "doctor") => listPatientPrescriptions(A.as(role), patientId, raw);
const idsOf = async (raw: unknown = {}) => {
  const page = await list(raw);
  if (!page.ok) throw new Error(page.message);
  return page.value.rows.map((r) => r.id);
};

beforeAll(async () => {
  A = await createTestTenant("history-a");
  B = await createTestTenant("history-b");
  const created = await createPatient(A.as("owner"), { name: "History Patient" });
  if (!created.ok) throw new Error(created.message);
  patientId = created.value.id;

  ids.fever = await finalized({ chiefComplaint: "Fever 50% better", diagnosis: ["Viral fever"], items: [{ drugName: "Paracetamol" }] });
  // A draft from January: 2026-01-10T20:00Z is 11 January in India.
  ids.migraine = await draft({ diagnosis: ["Migraine"], items: [{ drugName: "Naproxen" }] });
  await adminDb.update(prescriptions).set({ createdAt: new Date("2026-01-10T20:00:00.000Z") }).where(eq(prescriptions.id, ids.migraine));
  // Version 1 superseded by version 2.
  ids.superseded = await finalized({ diagnosis: ["Gastritis"], items: [{ drugName: "Pantoprazole" }] });
  const amendment = await amendPrescription(A.as("doctor"), { prescriptionId: ids.superseded, reason: "Dose correction" });
  if (!amendment.ok) throw new Error(amendment.message);
  const v2 = await finalizeNow(A.as("doctor"), amendment.value.prescriptionId);
  if (!v2.ok) throw new Error(v2.message);
  ids.current = amendment.value.prescriptionId;
  // A draft opened for another doctor.
  const [second] = await adminDb.insert(doctors).values({ tenantId: A.tenantId, displayName: "Dr Second" }).returning();
  secondDoctorId = second.id;
  ids.other = await draft({ diagnosis: ["Sprain"], items: [{ drugName: "Ibuprofen" }] });
  const [otherRx] = await adminDb.select({ visitId: prescriptions.visitId }).from(prescriptions).where(eq(prescriptions.id, ids.other));
  await adminDb.update(visits).set({ doctorId: secondDoctorId }).where(eq(visits.id, otherRx.visitId));
});

afterAll(async () => {
  await A.cleanup();
  await B.cleanup();
});

describe("listPatientPrescriptions", () => {
  it("lists every version of the patient, newest first by finalized-or-created time", async () => {
    const rows = await idsOf();
    expect(rows).toHaveLength(5);
    expect(rows.at(-1)).toBe(ids.migraine); // January
    const page = await list();
    if (!page.ok) throw new Error(page.message);
    expect(page.value.hasMore).toBe(false);
    expect(page.value.timeZone).toBe("Asia/Kolkata");
  });

  it("filters by status", async () => {
    expect(await idsOf({ status: "amended" })).toEqual([ids.superseded]);
    expect((await idsOf({ status: "finalized" })).sort()).toEqual([ids.current, ids.fever].sort());
    expect((await idsOf({ status: "draft" })).sort()).toEqual([ids.migraine, ids.other].sort());
  });

  it("filters by the visit's doctor and lists each doctor once", async () => {
    expect(await idsOf({ doctor: secondDoctorId })).toEqual([ids.other]);
    const page = await list();
    if (!page.ok) throw new Error(page.message);
    expect(page.value.doctors.map((d) => d.name)).toContain("Dr Second");
    expect(new Set(page.value.doctors.map((d) => d.id)).size).toBe(page.value.doctors.length);
  });

  it("finds text in the diagnosis or the chief complaint, with wildcards taken literally", async () => {
    expect(await idsOf({ q: "viral" })).toEqual([ids.fever]);
    expect(await idsOf({ q: "50%" })).toEqual([ids.fever]);
    expect(await idsOf({ q: "%" })).toEqual([ids.fever]);
    expect(await idsOf({ q: "_" })).toEqual([]);
    expect(await idsOf({ q: "gastr" })).toEqual(expect.arrayContaining([ids.superseded, ids.current]));
  });

  it("uses the clinic's calendar days for date filters", async () => {
    expect(await idsOf({ from: "2026-01-11", to: "2026-01-11" })).toEqual([ids.migraine]);
    expect(await idsOf({ from: "2026-01-10", to: "2026-01-10" })).toEqual([]);
    await adminDb.update(clinics).set({ timezone: "UTC" }).where(eq(clinics.tenantId, A.tenantId));
    try {
      expect(await idsOf({ from: "2026-01-10", to: "2026-01-10" })).toEqual([ids.migraine]);
    } finally {
      await adminDb.update(clinics).set({ timezone: "Asia/Kolkata" }).where(eq(clinics.tenantId, A.tenantId));
    }
  });

  it("swaps a reversed range and ignores malformed values instead of failing", async () => {
    expect(await idsOf({ from: "2026-01-12", to: "2026-01-11" })).toEqual([ids.migraine]);
    expect(parseHistoryFilters({ from: "2026-13-45", to: "yesterday", status: "void", doctor: "nope", q: ["fever", "x"], offset: "-1" })).toEqual({
      from: undefined,
      to: undefined,
      doctor: undefined,
      status: undefined,
      q: "fever",
      offset: 0,
    });
    expect((await idsOf({ status: "void", offset: "abc" })).length).toBe(5);
  });

  it("pages through more than one page with no row repeated or skipped", async () => {
    for (let i = 0; i < HISTORY_PAGE_SIZE; i += 1) await draft({ items: [{ drugName: `Page drug ${i}` }] });
    const first = await list();
    const second = await list({ offset: String(HISTORY_PAGE_SIZE) });
    if (!first.ok || !second.ok) throw new Error("list failed");
    expect(first.value.rows).toHaveLength(HISTORY_PAGE_SIZE);
    expect(first.value.hasMore).toBe(true);
    expect(second.value.rows).toHaveLength(5);
    expect(second.value.hasMore).toBe(false);
    const all = [...first.value.rows, ...second.value.rows].map((r) => r.id);
    expect(new Set(all).size).toBe(HISTORY_PAGE_SIZE + 5);
  });

  it("is refused to roles without rx.read and never shows another clinic's patient", async () => {
    expect(await list({}, "accountant")).toMatchObject({ ok: false, code: "forbidden" });
    expect(await list({}, "reception")).toMatchObject({ ok: true });
    expect(await listPatientPrescriptions(B.as("owner"), patientId, {})).toMatchObject({ ok: false, code: "not_found" });
    expect(await listPatientPrescriptions(A.as("doctor"), "not-a-uuid", {})).toMatchObject({ ok: false, code: "not_found" });
  });

  it("shows an archived patient's history only to the owner", async () => {
    await adminDb.update(patients).set({ deletedAt: new Date() }).where(eq(patients.id, patientId));
    try {
      expect(await list({}, "doctor")).toMatchObject({ ok: false, code: "not_found" });
      expect(await list({}, "owner")).toMatchObject({ ok: true });
    } finally {
      await adminDb.update(patients).set({ deletedAt: null }).where(eq(patients.id, patientId));
    }
  });
});
