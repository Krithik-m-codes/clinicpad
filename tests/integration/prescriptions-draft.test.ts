import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { withTenant } from "@/server/db/tenant";
import { adminDb } from "@/server/db/admin";
import { auditEvents, prescriptions, visits } from "@/server/db/schema";
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

  it("returns not_found for unknown, malformed, other-clinic, and archived patients", async () => {
    expect(await startPrescription(A.as("doctor"), { patientId: newId() })).toMatchObject({ ok: false, code: "not_found" });
    expect(await startPrescription(A.as("doctor"), { patientId: "nope" })).toMatchObject({ ok: false, code: "not_found" });
    expect(await startPrescription(B.as("doctor"), { patientId })).toMatchObject({ ok: false, code: "not_found" });

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

  it("is denied to roles that cannot draft, and hidden from other clinics", async () => {
    const id = await start();
    expect(await saveDraft(A.as("reception"), id, draft())).toMatchObject({ ok: false, code: "forbidden" });
    expect(await saveDraft(B.as("doctor"), id, draft())).toMatchObject({ ok: false, code: "not_found" });
    expect(await saveDraft(A.as("doctor"), "not-a-uuid", draft())).toMatchObject({ ok: false, code: "not_found" });
  });
});

describe("getPrescription", () => {
  it("lets reception and nurses read, denies accountants, and hides other clinics' records", async () => {
    const id = await start();
    expect((await getPrescription(A.as("reception"), id)).ok).toBe(true);
    expect((await getPrescription(A.as("nurse"), id)).ok).toBe(true);
    expect(await getPrescription(A.as("accountant"), id)).toMatchObject({ ok: false, code: "forbidden" });
    expect(await getPrescription(B.as("owner"), id)).toMatchObject({ ok: false, code: "not_found" });
    expect(await getPrescription(A.as("owner"), "x")).toMatchObject({ ok: false, code: "not_found" });
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
});
