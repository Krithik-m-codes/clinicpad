import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { adminDb } from "@/server/db/admin";
import { withTenant } from "@/server/db/tenant";
import { pgErrorInfo } from "@/server/db/errors";
import { auditEvents, prescriptionItems, prescriptions, tenantCounters, visits } from "@/server/db/schema";
import { NUL_MESSAGE } from "@/server/validation/text";
import { archivePatient, createPatient } from "@/server/services/patients";
import { amendPrescription, getPrescription, repeatPrescription, startPrescription } from "@/server/services/prescriptions";
import { finalizeNow, saveDraftNow } from "../helpers/rx";
import { createTestTenant, type TestTenant } from "../helpers/tenant";

let A: TestTenant;
let B: TestTenant;
let patientId = "";

beforeAll(async () => {
  A = await createTestTenant("lifea");
  B = await createTestTenant("lifeb");
  const p = await createPatient(A.as("reception"), { name: "Lifecycle Patient" });
  if (!p.ok) throw new Error(p.message);
  patientId = p.value.id;
});
afterAll(async () => {
  await A.cleanup();
  await B.cleanup();
});

const doctor = () => A.as("doctor");

async function draftWithItem(drugName = "Paracetamol"): Promise<string> {
  const started = await startPrescription(doctor(), { patientId });
  if (!started.ok) throw new Error(started.message);
  const id = started.value.prescriptionId;
  const saved = await saveDraftNow(doctor(), id, {
    chiefComplaint: "Fever",
    diagnosis: ["Viral fever"],
    items: [{ drugName, dose: "1 tablet", timing: "TDS", durationDays: 3 }],
  });
  if (!saved.ok) throw new Error(saved.message);
  return id;
}

async function finalized(drugName?: string): Promise<{ id: string; rxNo: number }> {
  const id = await draftWithItem(drugName);
  const done = await finalizeNow(doctor(), id);
  if (!done.ok) throw new Error(done.message);
  return { id, rxNo: done.value.rxNo };
}

async function expectStatus(id: string, status: string): Promise<void> {
  const got = await getPrescription(doctor(), id);
  expect(got).toMatchObject({ ok: true, value: { status } });
}

async function rowCounts(): Promise<{ prescriptions: number; visits: number }> {
  const rx = await adminDb.select({ id: prescriptions.id }).from(prescriptions).where(eq(prescriptions.tenantId, A.tenantId));
  const vs = await adminDb.select({ id: visits.id }).from(visits).where(eq(visits.tenantId, A.tenantId));
  return { prescriptions: rx.length, visits: vs.length };
}

async function rxCounter(): Promise<number> {
  const rows = await adminDb.select().from(tenantCounters).where(eq(tenantCounters.tenantId, A.tenantId));
  return rows.find((c) => c.name === "rx")?.lastNo ?? 0;
}

describe("finalizePrescription", () => {
  it("refuses an empty prescription and assigns no number", async () => {
    const started = await startPrescription(doctor(), { patientId });
    if (!started.ok) throw new Error(started.message);
    const counterBefore = await rxCounter();
    const result = await finalizeNow(doctor(), started.value.prescriptionId);
    expect(result).toMatchObject({ ok: false, code: "invalid", field: "items" });
    const got = await getPrescription(doctor(), started.value.prescriptionId);
    expect(got.ok && got.value.rxNo).toBeNull();
    expect(await rxCounter()).toBe(counterBefore);
  });

  it("assigns sequential Rx numbers; abandoned drafts do not consume numbers", async () => {
    const first = await finalized();
    await draftWithItem(); // abandoned, never finalized
    await draftWithItem(); // abandoned
    const second = await finalized();
    expect(second.rxNo).toBe(first.rxNo + 1);
  });

  it("finalizes the prescription and its visit together", async () => {
    const { id } = await finalized();
    const [rx] = await adminDb.select().from(prescriptions).where(eq(prescriptions.id, id));
    const [visit] = await adminDb.select().from(visits).where(eq(visits.id, rx.visitId));
    expect(rx).toMatchObject({ status: "finalized", finalizedBy: doctor().userId });
    expect(rx.finalizedAt).not.toBeNull();
    expect(visit.status).toBe("finalized");
    expect(visit.finalizedAt).not.toBeNull();
  });

  it("lets an owner finalize as well", async () => {
    const id = await draftWithItem();
    expect(await finalizeNow(A.as("owner"), id)).toMatchObject({ ok: true });
  });

  it("freezes the record and writes an audit event", async () => {
    const { id } = await finalized();
    const got = await getPrescription(doctor(), id);
    expect(got).toMatchObject({ ok: true, value: { status: "finalized", version: 1 } });

    expect(await saveDraftNow(doctor(), id, { items: [{ drugName: "Changed" }] })).toMatchObject({
      ok: false,
      code: "immutable",
    });

    const audit = await withTenant(A.tenantId, (tx) =>
      tx.select().from(auditEvents).where(eq(auditEvents.entityId, id)),
    );
    expect(audit.map((e) => e.action).sort()).toEqual(["prescription.drafted", "prescription.finalized"]);
  });

  it("cannot be bypassed with direct SQL, even as admin", async () => {
    const { id } = await finalized();
    const error = await adminDb
      .update(prescriptionItems)
      .set({ drugName: "Tampered" })
      .where(eq(prescriptionItems.prescriptionId, id))
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(pgErrorInfo(error).code).toBe("23000");
  });

  it("is idempotent under a double-click: exactly one success, one conflict, no burned number", async () => {
    const id = await draftWithItem();
    const beforeRx = await rxCounter();

    const [r1, r2] = await Promise.all([finalizeNow(doctor(), id), finalizeNow(doctor(), id)]);
    const results = [r1, r2];
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toMatchObject({ ok: false, code: "conflict" });
    expect(await rxCounter()).toBe(beforeRx + 1);

    // The sequence stays gap-free: the next finalize gets the very next number.
    const winner = results.find((r) => r.ok);
    const next = await finalized();
    expect(winner && winner.ok && next.rxNo).toBe(beforeRx + 2);
  });

  it("hands concurrent finalizes of different drafts distinct consecutive numbers", async () => {
    const ids = await Promise.all([draftWithItem(), draftWithItem(), draftWithItem()]);
    const beforeRx = await rxCounter();
    const results = await Promise.all(ids.map((id) => finalizeNow(doctor(), id)));
    const numbers = results.map((r) => (r.ok ? r.value.rxNo : -1)).sort((x, y) => x - y);
    expect(numbers).toEqual([beforeRx + 1, beforeRx + 2, beforeRx + 3]);
  });

  it.each(["reception", "nurse", "accountant", "pharmacist"])("forbids %s", async (role) => {
    const id = await draftWithItem();
    expect(await finalizeNow(A.as(role), id)).toMatchObject({ ok: false, code: "forbidden" });
    const got = await getPrescription(doctor(), id);
    expect(got).toMatchObject({ ok: true, value: { status: "draft", rxNo: null } });
  });

  it("returns not_found for another clinic's or a malformed id", async () => {
    const id = await draftWithItem();
    expect(await finalizeNow(B.as("doctor"), id)).toMatchObject({ ok: false, code: "not_found" });
    expect(await finalizeNow(A.as("doctor"), "nope")).toMatchObject({ ok: false, code: "not_found" });
  });
});

describe("amendPrescription", () => {
  it("creates v2 as a draft with the same Rx number, copied items, and the reason", async () => {
    const { id, rxNo } = await finalized("Original Drug");
    const amended = await amendPrescription(doctor(), { prescriptionId: id, reason: "Wrong dose entered" });
    expect(amended).toMatchObject({ ok: true, value: { version: 2 } });
    if (!amended.ok) throw new Error();

    const v2 = await getPrescription(doctor(), amended.value.prescriptionId);
    expect(v2).toMatchObject({
      ok: true,
      value: {
        status: "draft",
        version: 2,
        rxNo,
        amendmentReason: "Wrong dose entered",
        parentPrescriptionId: id,
      },
    });
    expect(v2.ok && v2.value.items.map((i) => i.drugName)).toEqual(["Original Drug"]);
    expect(v2.ok && v2.value.visit.chiefComplaint).toBe("Fever");

    // v1 is untouched until v2 is finalized.
    const v1 = await getPrescription(doctor(), id);
    expect(v1).toMatchObject({ ok: true, value: { status: "finalized", version: 1 } });
  });

  it("keeps the free-text reason out of the audit log", async () => {
    const { id } = await finalized();
    const reason = "Patient reported a penicillin allergy";
    const amended = await amendPrescription(doctor(), { prescriptionId: id, reason });
    if (!amended.ok) throw new Error(amended.message);

    const audit = await withTenant(A.tenantId, (tx) =>
      tx.select().from(auditEvents).where(eq(auditEvents.entityId, amended.value.prescriptionId)),
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: "prescription.amendment_drafted",
      before: { version: 1 },
      after: { version: 2, reasonLength: reason.length },
    });
    expect(JSON.stringify(audit)).not.toContain("penicillin");

    // The reason itself lives on the prescription row.
    const v2 = await getPrescription(doctor(), amended.value.prescriptionId);
    expect(v2.ok && v2.value.amendmentReason).toBe(reason);
  });

  it("finalizing v2 marks v1 amended, keeps the Rx number, and leaves v1's content intact", async () => {
    const { id, rxNo } = await finalized("Dose Error Drug");
    const amended = await amendPrescription(doctor(), { prescriptionId: id, reason: "Correct the drug" });
    if (!amended.ok) throw new Error(amended.message);
    const v2Id = amended.value.prescriptionId;

    await saveDraftNow(doctor(), v2Id, { chiefComplaint: "Fever", items: [{ drugName: "Corrected Drug" }] });
    const done = await finalizeNow(doctor(), v2Id);
    expect(done).toMatchObject({ ok: true, value: { rxNo, version: 2 } });

    const v1 = await getPrescription(doctor(), id);
    expect(v1).toMatchObject({ ok: true, value: { status: "amended", version: 1 } });
    expect(v1.ok && v1.value.items.map((i) => i.drugName)).toEqual(["Dose Error Drug"]);

    const v2 = await getPrescription(doctor(), v2Id);
    expect(v2).toMatchObject({ ok: true, value: { status: "finalized", version: 2, rxNo } });
    expect(v2.ok && v2.value.items.map((i) => i.drugName)).toEqual(["Corrected Drug"]);

    const audit = await withTenant(A.tenantId, (tx) =>
      tx.select().from(auditEvents).where(eq(auditEvents.entityId, v2Id)),
    );
    expect(audit.map((e) => e.action).sort()).toEqual(["prescription.amended", "prescription.amendment_drafted"]);
  });

  it("does not consume a new Rx number when an amendment is finalized", async () => {
    const { id, rxNo } = await finalized();
    const counterBefore = await rxCounter();
    const amended = await amendPrescription(doctor(), { prescriptionId: id, reason: "No new number please" });
    if (!amended.ok) throw new Error(amended.message);
    // Items are copied from v1; no saveDraft first.
    expect(await finalizeNow(doctor(), amended.value.prescriptionId)).toMatchObject({
      ok: true,
      value: { rxNo, version: 2 },
    });
    await expectStatus(id, "amended");
    expect(await rxCounter()).toBe(counterBefore);
  });

  it("records the parent id in the audit payloads of the amendment", async () => {
    const { id } = await finalized();
    const amended = await amendPrescription(doctor(), { prescriptionId: id, reason: "Audit the parent id" });
    if (!amended.ok) throw new Error(amended.message);
    expect(await finalizeNow(doctor(), amended.value.prescriptionId)).toMatchObject({ ok: true });

    const audit = await withTenant(A.tenantId, (tx) =>
      tx.select().from(auditEvents).where(eq(auditEvents.entityId, amended.value.prescriptionId)),
    );
    const drafted = audit.find((e) => e.action === "prescription.amendment_drafted");
    const done = audit.find((e) => e.action === "prescription.amended");
    expect(drafted?.after).toMatchObject({ parentPrescriptionId: id });
    expect(done?.after).toMatchObject({ parentPrescriptionId: id });
  });

  it("refuses to finalize an amendment whose parent has no Rx number, and burns no number", async () => {
    // Unreachable through the services: build the corrupt chain directly as admin.
    const T = await createTestTenant("norxno");
    try {
      const p = await createPatient(T.as("owner"), { name: "No Rx Number" });
      if (!p.ok) throw new Error(p.message);
      const [parentVisit] = await adminDb
        .insert(visits)
        .values({ tenantId: T.tenantId, patientId: p.value.id })
        .returning({ id: visits.id });
      const [parent] = await adminDb
        .insert(prescriptions)
        .values({ tenantId: T.tenantId, visitId: parentVisit.id })
        .returning({ id: prescriptions.id });
      await adminDb.update(prescriptions).set({ status: "finalized" }).where(eq(prescriptions.id, parent.id));
      const [childVisit] = await adminDb
        .insert(visits)
        .values({ tenantId: T.tenantId, patientId: p.value.id })
        .returning({ id: visits.id });
      const [child] = await adminDb
        .insert(prescriptions)
        .values({
          tenantId: T.tenantId,
          visitId: childVisit.id,
          version: 2,
          parentPrescriptionId: parent.id,
          amendmentReason: "Corrupt chain",
        })
        .returning({ id: prescriptions.id });
      await adminDb.insert(prescriptionItems).values({ tenantId: T.tenantId, prescriptionId: child.id, drugName: "X" });

      expect(await finalizeNow(T.as("doctor"), child.id)).toMatchObject({ ok: false, code: "conflict" });
      const counters = await adminDb.select().from(tenantCounters).where(eq(tenantCounters.tenantId, T.tenantId));
      expect(counters.find((c) => c.name === "rx")).toBeUndefined();
    } finally {
      await T.cleanup();
    }
  });

  it("exposes the open-amendment index name that the service matches on", async () => {
    const { id } = await finalized();
    const amended = await amendPrescription(doctor(), { prescriptionId: id, reason: "Index name check" });
    if (!amended.ok) throw new Error(amended.message);
    const [visit] = await adminDb
      .insert(visits)
      .values({ tenantId: A.tenantId, patientId })
      .returning({ id: visits.id });
    const error = await adminDb
      .insert(prescriptions)
      .values({ tenantId: A.tenantId, visitId: visit.id, version: 2, parentPrescriptionId: id })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(pgErrorInfo(error)).toEqual({ code: "23505", constraint: "prescriptions_one_open_amendment" });
  });

  it("lets an owner amend", async () => {
    const { id } = await finalized();
    expect(await amendPrescription(A.as("owner"), { prescriptionId: id, reason: "Owner amendment" })).toMatchObject({
      ok: true,
      value: { version: 2 },
    });
  });

  it("rejects a reason over 500 characters", async () => {
    const { id } = await finalized();
    expect(await amendPrescription(doctor(), { prescriptionId: id, reason: "x".repeat(501) })).toMatchObject({
      ok: false,
      code: "invalid",
      field: "reason",
    });
    expect(await amendPrescription(doctor(), { prescriptionId: id, reason: "x".repeat(500) })).toMatchObject({
      ok: true,
    });
  });

  it("rejects a NUL character in the reason as invalid and writes no amendment", async () => {
    const NUL = "\u0000";
    expect([...NUL]).toHaveLength(1);
    const { id } = await finalized();
    const before = await rowCounts();
    expect(await amendPrescription(doctor(), { prescriptionId: id, reason: `Wrong${NUL} dose` })).toMatchObject({
      ok: false,
      code: "invalid",
      field: "reason",
      // The validation guard's own message, not the database fallback's: removing the guard must fail this.
      message: NUL_MESSAGE,
    });
    expect(await rowCounts()).toEqual(before);
    await expectStatus(id, "finalized");
  });

  it("allows only one open amendment, and none from an already-amended version", async () => {
    const { id } = await finalized();
    const first = await amendPrescription(doctor(), { prescriptionId: id, reason: "First amendment" });
    expect(first.ok).toBe(true);
    expect(await amendPrescription(doctor(), { prescriptionId: id, reason: "Second at once" })).toMatchObject({
      ok: false,
      code: "conflict",
    });

    if (!first.ok) throw new Error();
    // v2 must really be finalized (and v1 amended), or the next conflict could be the open-amendment one.
    expect(await finalizeNow(doctor(), first.value.prescriptionId)).toMatchObject({ ok: true });
    await expectStatus(id, "amended");
    expect(await amendPrescription(doctor(), { prescriptionId: id, reason: "Amend the old one" })).toMatchObject({
      ok: false,
      code: "conflict",
    });
  });

  it("survives two simultaneous amend requests", async () => {
    const { id } = await finalized();
    const [r1, r2] = await Promise.all([
      amendPrescription(doctor(), { prescriptionId: id, reason: "Race one" }),
      amendPrescription(doctor(), { prescriptionId: id, reason: "Race two" }),
    ]);
    expect([r1, r2].filter((r) => r.ok)).toHaveLength(1);
    expect([r1, r2].find((r) => !r.ok)).toMatchObject({ ok: false, code: "conflict" });
  });

  it("rejects a draft, a missing/short reason, and unauthorized roles", async () => {
    const draftId = await draftWithItem();
    expect(await amendPrescription(doctor(), { prescriptionId: draftId, reason: "Not final yet" })).toMatchObject({
      ok: false,
      code: "conflict",
    });

    const { id } = await finalized();
    expect(await amendPrescription(doctor(), { prescriptionId: id, reason: "no" })).toMatchObject({
      ok: false,
      code: "invalid",
      field: "reason",
    });
    expect(await amendPrescription(doctor(), { prescriptionId: id, reason: "     " })).toMatchObject({
      ok: false,
      code: "invalid",
      field: "reason",
    });
    for (const role of ["reception", "nurse", "accountant", "pharmacist"]) {
      expect(await amendPrescription(A.as(role), { prescriptionId: id, reason: "Valid reason here" })).toMatchObject({
        ok: false,
        code: "forbidden",
      });
    }
    expect(await amendPrescription(B.as("doctor"), { prescriptionId: id, reason: "Valid reason here" })).toMatchObject({
      ok: false,
      code: "not_found",
    });
    expect(await amendPrescription(doctor(), { prescriptionId: "nope", reason: "Valid reason here" })).toMatchObject({
      ok: false,
      code: "not_found",
    });
  });

  it("leaves a deletable tenant: parent and child versions cascade away with the clinic", async () => {
    const T = await createTestTenant("cascade");
    try {
      const p = await createPatient(T.as("owner"), { name: "Cascade Patient" });
      if (!p.ok) throw new Error(p.message);
      const s = await startPrescription(T.as("doctor"), { patientId: p.value.id });
      if (!s.ok) throw new Error(s.message);
      await saveDraftNow(T.as("doctor"), s.value.prescriptionId, { items: [{ drugName: "X" }] });
      expect(await finalizeNow(T.as("doctor"), s.value.prescriptionId)).toMatchObject({ ok: true });
      const a = await amendPrescription(T.as("doctor"), { prescriptionId: s.value.prescriptionId, reason: "Cascade check" });
      if (!a.ok) throw new Error(a.message);
      expect(await finalizeNow(T.as("doctor"), a.value.prescriptionId)).toMatchObject({ ok: true });
      // The chain really contains an amended parent and a finalized child.
      const chain = await adminDb.select().from(prescriptions).where(eq(prescriptions.tenantId, T.tenantId));
      expect(chain.map((r) => r.status).sort()).toEqual(["amended", "finalized"]);
    } finally {
      await T.cleanup();
    }
    const left = await adminDb.select().from(prescriptions).where(eq(prescriptions.tenantId, T.tenantId));
    expect(left).toHaveLength(0);
  });
});

describe("repeatPrescription", () => {
  it("creates an independent draft with copied items and no Rx number", async () => {
    const { id, rxNo } = await finalized("Repeat Drug");
    const repeated = await repeatPrescription(doctor(), id);
    if (!repeated.ok) throw new Error(repeated.message);

    const copy = await getPrescription(doctor(), repeated.value.prescriptionId);
    expect(copy).toMatchObject({
      ok: true,
      value: { status: "draft", version: 1, rxNo: null, parentPrescriptionId: null, amendmentReason: null },
    });
    expect(copy.ok && copy.value.items.map((i) => i.drugName)).toEqual(["Repeat Drug"]);
    expect(copy.ok && copy.value.visit.visitType).toBe("follow-up");

    const original = await getPrescription(doctor(), id);
    expect(original).toMatchObject({ ok: true, value: { status: "finalized", rxNo } });
  });

  it("repeats the latest version, not the superseded one, and audits the copy", async () => {
    const { id } = await finalized("Old Version Drug");
    const amended = await amendPrescription(doctor(), { prescriptionId: id, reason: "Amend before repeat" });
    if (!amended.ok) throw new Error(amended.message);
    const v2Id = amended.value.prescriptionId;
    expect(await saveDraftNow(doctor(), v2Id, { items: [{ drugName: "Corrected Drug" }] })).toMatchObject({ ok: true });
    expect(await finalizeNow(doctor(), v2Id)).toMatchObject({ ok: true });
    await expectStatus(id, "amended");

    // The superseded v1 is refused and nothing is created.
    const before = await rowCounts();
    expect(await repeatPrescription(doctor(), id)).toEqual({
      ok: false,
      code: "conflict",
      message: "This prescription was superseded by a later version; repeat the latest version.",
    });
    expect(await rowCounts()).toEqual(before);

    // The latest version repeats with the corrected content.
    const repeated = await repeatPrescription(doctor(), v2Id);
    if (!repeated.ok) throw new Error(repeated.message);
    const copy = await getPrescription(doctor(), repeated.value.prescriptionId);
    expect(copy.ok && copy.value.items.map((i) => i.drugName)).toEqual(["Corrected Drug"]);
    const audit = await withTenant(A.tenantId, (tx) =>
      tx.select().from(auditEvents).where(eq(auditEvents.entityId, repeated.value.prescriptionId)),
    );
    expect(audit.map((e) => e.action)).toEqual(["prescription.drafted"]);
    expect(audit[0].after).toMatchObject({ repeatedFrom: v2Id });
  });

  it("lets an owner repeat", async () => {
    const { id } = await finalized();
    expect(await repeatPrescription(A.as("owner"), id)).toMatchObject({ ok: true });
  });

  it("refuses to repeat for an archived patient", async () => {
    const p = await createPatient(A.as("reception"), { name: "Archived Patient" });
    if (!p.ok) throw new Error(p.message);
    const started = await startPrescription(doctor(), { patientId: p.value.id });
    if (!started.ok) throw new Error(started.message);
    const rxId = started.value.prescriptionId;
    expect(await saveDraftNow(doctor(), rxId, { items: [{ drugName: "Old" }] })).toMatchObject({ ok: true });
    expect(await finalizeNow(doctor(), rxId)).toMatchObject({ ok: true });
    expect(await archivePatient(A.as("owner"), p.value.id)).toMatchObject({ ok: true });

    const before = await rowCounts();
    expect(await repeatPrescription(doctor(), rxId)).toMatchObject({ ok: false, code: "not_found" });
    expect(await rowCounts()).toEqual(before);
  });

  it("rejects drafts, unauthorized roles, and other clinics", async () => {
    const draftId = await draftWithItem();
    expect(await repeatPrescription(doctor(), draftId)).toMatchObject({ ok: false, code: "conflict" });
    const { id } = await finalized();
    for (const role of ["reception", "nurse", "accountant", "pharmacist"]) {
      expect(await repeatPrescription(A.as(role), id)).toMatchObject({ ok: false, code: "forbidden" });
    }
    expect(await repeatPrescription(B.as("doctor"), id)).toMatchObject({ ok: false, code: "not_found" });
    expect(await repeatPrescription(doctor(), "nope")).toMatchObject({ ok: false, code: "not_found" });
  });
});
