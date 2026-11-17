import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { adminDb } from "@/server/db/admin";
import { pgErrorInfo } from "@/server/db/errors";
import { withTenant } from "@/server/db/tenant";
import { clinicAssets, clinics, doctors, prescriptionItems, prescriptions, tenantCounters, users, visits } from "@/server/db/schema";
import { createPatient, updatePatient } from "@/server/services/patients";
import { amendPrescription, finalizePrescription, repeatPrescription, saveDraft, startPrescription } from "@/server/services/prescriptions";
import { buildFinalSnapshot, buildRenderSnapshot } from "@/server/services/render-snapshot";
import { getVersionLinks, loadRxDocument } from "@/server/services/rx-documents";
import type { ServiceContext } from "@/server/services/context";
import { loadImageAssets } from "@/server/services/assets";
import { renderPrescription } from "@/lib/rx-render/render";
import { parseRenderSnapshot } from "@/lib/rx-render/snapshot";
import { newId } from "@/lib/domain/ids";
import { makePng } from "../helpers/images";
import { finalizeNow } from "../helpers/rx";
import { createTestTenant, type TestTenant } from "../helpers/tenant";

let A: TestTenant;
let B: TestTenant;
let firstLogoId = "";
let secondLogoId = "";
let secondDoctorUserId = "";
let legacyRxNo = 9500;
const doctor = () => A.as("doctor");
/** Another doctor of clinic A, with a profile of their own. */
const secondDoctor = (): ServiceContext => ({ tenantId: A.tenantId, userId: secondDoctorUserId, role: "doctor" });
const NO_FONTS = { logo: null, signature: null, fontCss: "" };

async function insertLogo(width: number): Promise<string> {
  return insertImage("logo", makePng(width, 20), width, 20);
}

async function insertImage(
  kind: "logo" | "signature",
  bytes: Buffer,
  width: number,
  height: number,
  tenantId = A.tenantId,
): Promise<string> {
  const [row] = await adminDb
    .insert(clinicAssets)
    .values({
      tenantId,
      kind,
      mime: "image/png",
      width,
      height,
      byteSize: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes,
    })
    .returning({ id: clinicAssets.id });
  return row.id;
}

async function patient(name: string, dob?: string): Promise<string> {
  const created = await createPatient(A.as("reception"), { name, dob }, { allowDuplicate: true });
  if (!created.ok) throw new Error(created.message);
  return created.value.id;
}

/** A draft with one medicine, saved the way the editor saves it. Returns the id and the saved revision. */
async function savedDraftFor(patientId: string): Promise<{ id: string; revision: number }> {
  const started = await startPrescription(doctor(), { patientId });
  if (!started.ok) throw new Error(started.message);
  const id = started.value.prescriptionId;
  const saved = await saveDraft(doctor(), id, { items: [{ drugName: "Paracetamol", doseMorning: 1, doseNight: 1 }] }, { baseRevision: 0 });
  if (!saved.ok) throw new Error(saved.message);
  return { id, revision: saved.value.revision };
}

/** Finalized exactly the way finalizeDraftAction does it: the saved revision is the expected one. */
async function finalizedFor(patientId: string, by: ServiceContext = doctor()): Promise<string> {
  const { id, revision } = await savedDraftFor(patientId);
  const done = await finalizePrescription(by, id, { expectedRevision: revision });
  if (!done.ok) throw new Error(done.message);
  return id;
}

async function load(id: string, role = "nurse") {
  const result = await loadRxDocument(A.as(role), id);
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  return result.value;
}

/** A finalized prescription written the way rows were written before this plan: no snapshot, no finalized_by. */
async function legacyFinalized(patientId: string, finalizedAt: Date, snapshot: unknown = null): Promise<string> {
  const [doc] = await adminDb.select({ id: doctors.id }).from(doctors).where(eq(doctors.userId, doctor().userId)).limit(1);
  const [visit] = await adminDb
    .insert(visits)
    .values({ tenantId: A.tenantId, patientId, doctorId: doc.id, status: "draft", diagnosis: ["Legacy"] })
    .returning();
  const [rx] = await adminDb
    .insert(prescriptions)
    .values({ tenantId: A.tenantId, visitId: visit.id, status: "draft", renderSnapshot: snapshot })
    .returning();
  await adminDb.insert(prescriptionItems).values({ tenantId: A.tenantId, prescriptionId: rx.id, drugName: "Legacy drug" });
  legacyRxNo += 1;
  await adminDb.update(prescriptions).set({ status: "finalized", rxNo: legacyRxNo, finalizedAt }).where(eq(prescriptions.id, rx.id));
  // The draft-visit guard (0008) accepts only the plain flip once the prescription is finalized.
  await adminDb.update(visits).set({ status: "finalized", finalizedAt }).where(eq(visits.id, visit.id));
  return rx.id;
}

beforeAll(async () => {
  A = await createTestTenant("snapa");
  B = await createTestTenant("snapb");
  firstLogoId = await insertLogo(40);
  secondLogoId = await insertLogo(41);
  await adminDb
    .update(clinics)
    .set({
      name: "Snapshot Clinic",
      addressLine1: "1 Old Road",
      city: "Pune",
      pincode: "411001",
      phone: "020-1111 2222",
      padFooter: "Closed on Sundays\n\n  Bring old papers  ",
      logoAssetId: firstLogoId,
    })
    .where(eq(clinics.tenantId, A.tenantId));
  await adminDb
    .update(doctors)
    .set({ displayName: "Dr Snapshot", regNo: "MMC-1234", qualifications: "MBBS" })
    .where(eq(doctors.userId, doctor().userId));
  const [user] = await adminDb
    .insert(users)
    .values({ email: `snap-second-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`, name: "Dr Second", passwordHash: "not-a-real-hash" })
    .returning();
  secondDoctorUserId = user.id;
  await adminDb.insert(doctors).values({ tenantId: A.tenantId, userId: user.id, displayName: "Dr Second", regNo: "MMC-2222" });
});

afterAll(async () => {
  try {
    await A.cleanup();
    await B.cleanup();
  } finally {
    if (secondDoctorUserId) await adminDb.delete(users).where(eq(users.id, secondDoctorUserId));
  }
});

describe("finalize freezes the printed details", () => {
  let id = "";
  let patientId = "";

  it("writes a snapshot of the patient, clinic, doctor, and layout", async () => {
    patientId = await patient("Snapshot Patient", "2020-03-15");
    id = await finalizedFor(patientId);
    const [row] = await adminDb.select().from(prescriptions).where(eq(prescriptions.id, id));
    const snap = parseRenderSnapshot(row.renderSnapshot);
    expect(snap).toMatchObject({
      v: 1,
      patient: { name: "Snapshot Patient", dob: "2020-03-15", gender: "unknown", allergies: [] },
      clinic: {
        name: "Snapshot Clinic",
        addressLines: ["1 Old Road", "Pune - 411001"],
        phone: "020-1111 2222",
        footerLines: ["Closed on Sundays", "Bring old papers"],
        logoAssetId: firstLogoId,
        timezone: "Asia/Kolkata",
      },
      doctor: { name: "Dr Snapshot", registrationNo: "MMC-1234", qualifications: "MBBS" },
      layout: { template: { kind: "builtin", key: "general" }, paperSize: "A4", labels: "en" },
    });
    expect(snap?.patient.ageLabel).toMatch(/^\d+ y$/);
    expect(snap?.takenAt).toBe(row.finalizedAt?.toISOString());
    // The stored value is exactly what the builder produces for the same sources and instant.
    const rebuilt = await withTenant(A.tenantId, (tx) =>
      buildRenderSnapshot(tx, { tenantId: A.tenantId, patientId, prescriberUserId: doctor().userId, visitDoctorId: null, at: row.finalizedAt as Date }),
    );
    expect(row.renderSnapshot).toEqual(rebuilt);
  });

  it("cannot be changed afterwards, even on the admin connection", async () => {
    const error = await adminDb
      .update(prescriptions)
      .set({ renderSnapshot: { v: 1 } })
      .where(eq(prescriptions.id, id))
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(pgErrorInfo(error).code).toBe("23000");
  });

  it("cannot be changed afterwards by the application role either", async () => {
    const error = await withTenant(A.tenantId, (tx) =>
      tx.update(prescriptions).set({ renderSnapshot: { v: 1 } }).where(eq(prescriptions.id, id)),
    ).then(
      () => null,
      (e: unknown) => e,
    );
    expect(pgErrorInfo(error).code).toBe("23000");
  });

  it("reprints exactly what was finalized after the patient, clinic, doctor, logo, and template change", async () => {
    // updatePatient is a full replace: this clears the date of birth too, which the reprint must not show either.
    expect((await updatePatient(A.as("reception"), patientId, { name: "Renamed Patient" })).ok).toBe(true);
    await adminDb
      .update(clinics)
      .set({ name: "Moved Clinic", addressLine1: "99 New Road", rxTemplate: "derma", rxPaperSize: "A5", logoAssetId: secondLogoId })
      .where(eq(clinics.tenantId, A.tenantId));
    await adminDb.update(doctors).set({ regNo: "MMC-9999" }).where(eq(doctors.userId, doctor().userId));

    const bundle = await load(id);
    expect(bundle.document.snapshotSource).toBe("finalize");
    expect(bundle.document.snapshot.patient).toMatchObject({ name: "Snapshot Patient", dob: "2020-03-15" });
    expect(bundle.document.snapshot.clinic.name).toBe("Snapshot Clinic");
    expect(bundle.document.snapshot.doctor.registrationNo).toBe("MMC-1234");
    expect(bundle.document.snapshot.layout).toMatchObject({ template: { key: "general" }, paperSize: "A4" });

    // Compared with the bytes that were written (a real PNG, which contains 0x00 bytes), not with a re-read of the row.
    expect(makePng(40, 20).includes(0)).toBe(true);
    expect(bundle.logo?.base64).toBe(makePng(40, 20).toString("base64"));

    const printed = renderPrescription(bundle.document, NO_FONTS).html;
    expect(printed).toContain("Snapshot Patient");
    expect(printed).not.toContain("Renamed Patient");
    expect(printed).not.toContain("Moved Clinic");
  });

  it("gives an amendment its own snapshot and marks the original superseded", async () => {
    const amended = await amendPrescription(doctor(), { prescriptionId: id, reason: "Dose correction" });
    if (!amended.ok) throw new Error(amended.message);
    const v2 = amended.value.prescriptionId;
    // amendPrescription inserts the new version with an explicit column list: no snapshot is copied.
    const [draftRow] = await adminDb.select().from(prescriptions).where(eq(prescriptions.id, v2));
    expect(draftRow.renderSnapshot).toBeNull();
    expect((await finalizeNow(doctor(), v2)).ok).toBe(true);

    const second = await load(v2);
    expect(second.document.snapshot.patient.name).toBe("Renamed Patient");
    expect(second.document.snapshot.clinic.name).toBe("Moved Clinic");
    expect(second.document.snapshot.doctor.registrationNo).toBe("MMC-9999");
    expect(second.document.snapshot.layout).toMatchObject({ template: { key: "derma" }, paperSize: "A5" });
    expect(second.document).toMatchObject({ version: 2, replacesVersion: 1, supersededBy: null });

    const first = await load(id);
    expect(first.document.status).toBe("amended");
    expect(first.document.supersededBy).toMatchObject({ version: 2 });
    expect(first.document.snapshot.patient.name).toBe("Snapshot Patient");

    expect(await getVersionLinks(A.as("reception"), id)).toMatchObject({
      ok: true,
      value: { supersededBy: { id: v2, version: 2 }, replaces: null },
    });
    expect(await getVersionLinks(A.as("reception"), v2)).toMatchObject({
      ok: true,
      value: { supersededBy: null, replaces: { id, version: 1 } },
    });
  });
});

describe("new drafts never inherit a frozen snapshot", () => {
  it("starts a repeat of a finalized prescription without a snapshot", async () => {
    const id = await finalizedFor(await patient("Repeat Person"));
    const [source] = await adminDb.select().from(prescriptions).where(eq(prescriptions.id, id));
    expect(source.renderSnapshot).not.toBeNull();
    const repeated = await repeatPrescription(doctor(), id);
    if (!repeated.ok) throw new Error(repeated.message);
    const [row] = await adminDb.select().from(prescriptions).where(eq(prescriptions.id, repeated.value.prescriptionId));
    expect(row).toMatchObject({ status: "draft", rxNo: null, renderSnapshot: null, finalizedBy: null });
  });
});

describe("who signs the pad", () => {
  it("is the doctor who finalizes, also for an amendment of another doctor's prescription", async () => {
    const id = await finalizedFor(await patient("Signer Person"));
    expect((await load(id)).document.snapshot.doctor.name).toBe("Dr Snapshot");

    // The amendment's visit keeps the first doctor's doctor_id (ADR-0024); the second doctor finalizes it.
    const amended = await amendPrescription(secondDoctor(), { prescriptionId: id, reason: "Second opinion" });
    if (!amended.ok) throw new Error(amended.message);
    expect((await finalizeNow(secondDoctor(), amended.value.prescriptionId)).ok).toBe(true);
    expect((await load(amended.value.prescriptionId)).document.snapshot.doctor).toMatchObject({
      name: "Dr Second",
      registrationNo: "MMC-2222",
    });
  });

  it("prints no doctor, never the visit's doctor, when the finalizer has no doctor profile", async () => {
    const { id } = await savedDraftFor(await patient("No Profile Person"));
    const ownerWithoutProfile: ServiceContext = { tenantId: A.tenantId, userId: newId(), role: "owner" };
    expect((await finalizeNow(ownerWithoutProfile, id)).ok).toBe(true);
    const bundle = await load(id);
    expect(bundle.document.snapshot.doctor).toEqual({
      name: "",
      qualifications: null,
      designation: null,
      registrationNo: null,
      registrationCouncil: null,
      signatureAssetId: null,
    });
    expect(bundle.signature).toBeNull();
  });
});

describe("a snapshot that cannot be built", () => {
  it("fails cleanly, burns no Rx number, and leaves the draft untouched", async () => {
    const C = await createTestTenant("snapc");
    try {
      // 300 characters is more than the snapshot (and the write side) allows: the frozen copy would be unprintable.
      await adminDb.update(clinics).set({ name: "N".repeat(300) }).where(eq(clinics.tenantId, C.tenantId));
      const created = await createPatient(C.as("reception"), { name: "Unprintable Person" }, { allowDuplicate: true });
      if (!created.ok) throw new Error(created.message);
      const started = await startPrescription(C.as("doctor"), { patientId: created.value.id });
      if (!started.ok) throw new Error(started.message);
      const id = started.value.prescriptionId;
      const saved = await saveDraft(C.as("doctor"), id, { items: [{ drugName: "Paracetamol" }] }, { baseRevision: 0 });
      if (!saved.ok) throw new Error(saved.message);

      const refused = await finalizePrescription(C.as("doctor"), id, { expectedRevision: saved.value.revision });
      expect(refused).toMatchObject({ ok: false, code: "invalid" });
      const [row] = await adminDb.select().from(prescriptions).where(eq(prescriptions.id, id));
      expect(row).toMatchObject({ status: "draft", rxNo: null, finalizedAt: null, finalizedBy: null, renderSnapshot: null });
      const counters = await adminDb.select().from(tenantCounters).where(eq(tenantCounters.tenantId, C.tenantId));
      expect(counters.find((c) => c.name === "rx")?.lastNo ?? 0).toBe(0);

      // Fix the clinic profile: the same draft now finalizes and gets Rx number 1, so none was burned.
      await adminDb.update(clinics).set({ name: "Fixed Clinic" }).where(eq(clinics.tenantId, C.tenantId));
      expect(await finalizePrescription(C.as("doctor"), id, { expectedRevision: saved.value.revision })).toMatchObject({
        ok: true,
        value: { rxNo: 1 },
      });
    } finally {
      await C.cleanup();
    }
  });
});

describe("the frozen age uses the clinic's calendar day", () => {
  const sources = (patientId: string, at: string) => ({
    tenantId: A.tenantId,
    patientId,
    prescriberUserId: doctor().userId,
    visitDoctorId: null,
    at: new Date(at),
  });
  // 2026-11-16T20:00Z is 01:30 on 17 November in Kolkata, but still the 16th in UTC.
  const AT = "2026-11-16T20:00:00.000Z";

  it("counts a birthday that has already come in the clinic's zone", async () => {
    const id = await patient("Birthday Person", "2020-11-17");
    const snap = await withTenant(A.tenantId, (tx) => buildRenderSnapshot(tx, sources(id, AT)));
    expect(snap.patient.ageLabel).toBe("6 y");
  });

  it("counts a newborn's days to the clinic's date", async () => {
    const id = await patient("Newborn Person", "2026-11-05");
    const snap = await withTenant(A.tenantId, (tx) => buildRenderSnapshot(tx, sources(id, AT)));
    expect(snap.patient.ageLabel).toBe("12 d");
  });

  it("gives the earlier count before the clinic's midnight", async () => {
    const id = await patient("Evening Person", "2026-11-05");
    const snap = await withTenant(A.tenantId, (tx) => buildRenderSnapshot(tx, sources(id, "2026-11-16T17:00:00.000Z")));
    expect(snap.patient.ageLabel).toBe("11 d");
  });
});

describe("defence in depth behind row-level security", () => {
  it("reads nothing for another tenant's id, even from this tenant's transaction", async () => {
    const id = await patient("Scoped Person", "2020-03-15");
    const base = { patientId: id, prescriberUserId: doctor().userId, visitDoctorId: null, at: new Date() };
    const snap = await withTenant(A.tenantId, (tx) => buildRenderSnapshot(tx, { ...base, tenantId: B.tenantId }));
    expect(snap.patient.name).toBe("");
    expect(snap.doctor.name).toBe("");
    expect(snap.clinic.name).not.toBe("Moved Clinic");
    const final = await withTenant(A.tenantId, (tx) => buildFinalSnapshot(tx, { ...base, tenantId: B.tenantId }));
    expect(final).toMatchObject({ ok: false, code: "invalid" });
  });

  it("loads an image only as the kind the caller expects, and only from the tenant", async () => {
    const bytes = Buffer.from([0, 255, 0, 0x5c, 0x78, 1, 2, 3]);
    const sig = await insertImage("signature", bytes, 40, 20);
    const found = await withTenant(A.tenantId, (tx) => loadImageAssets(tx, A.tenantId, [{ id: sig, kind: "signature" }]));
    expect(found.get(sig)?.base64).toBe(bytes.toString("base64"));
    const wrongKind = await withTenant(A.tenantId, (tx) => loadImageAssets(tx, A.tenantId, [{ id: sig, kind: "logo" }]));
    expect(wrongKind.size).toBe(0);
    const otherTenant = await withTenant(A.tenantId, (tx) => loadImageAssets(tx, B.tenantId, [{ id: sig, kind: "signature" }]));
    expect(otherTenant.size).toBe(0);
  });
});

describe("a clinic with no profile", () => {
  it("refuses to finalize and burns no Rx number", async () => {
    const D = await createTestTenant("snapd");
    try {
      await adminDb.delete(clinics).where(eq(clinics.tenantId, D.tenantId));
      const created = await createPatient(D.as("reception"), { name: "No Clinic Person" }, { allowDuplicate: true });
      if (!created.ok) throw new Error(created.message);
      const started = await startPrescription(D.as("doctor"), { patientId: created.value.id });
      if (!started.ok) throw new Error(started.message);
      const id = started.value.prescriptionId;
      const saved = await saveDraft(D.as("doctor"), id, { items: [{ drugName: "Paracetamol" }] }, { baseRevision: 0 });
      if (!saved.ok) throw new Error(saved.message);

      expect(await finalizePrescription(D.as("doctor"), id, { expectedRevision: saved.value.revision })).toMatchObject({
        ok: false,
        code: "invalid",
      });
      const counters = await adminDb.select().from(tenantCounters).where(eq(tenantCounters.tenantId, D.tenantId));
      expect(counters.find((c) => c.name === "rx")?.lastNo ?? 0).toBe(0);
      const [row] = await adminDb.select().from(prescriptions).where(eq(prescriptions.id, id));
      expect(row).toMatchObject({ status: "draft", rxNo: null, renderSnapshot: null });
    } finally {
      await D.cleanup();
    }
  });
});

describe("a draft never prints from a stored snapshot", () => {
  it("ignores a stale snapshot on a draft, and finalize overwrites it", async () => {
    const { id, revision } = await savedDraftFor(await patient("Stale Person"));
    await adminDb.update(prescriptions).set({ renderSnapshot: {} }).where(eq(prescriptions.id, id));

    const preview = await load(id);
    expect(preview.document).toMatchObject({ status: "draft", snapshotSource: "live" });
    expect(preview.document.snapshot.patient.name).toBe("Stale Person");

    expect((await finalizePrescription(doctor(), id, { expectedRevision: revision })).ok).toBe(true);
    const [row] = await adminDb.select().from(prescriptions).where(eq(prescriptions.id, id));
    expect(parseRenderSnapshot(row.renderSnapshot)?.patient.name).toBe("Stale Person");
    expect((await load(id)).document.snapshotSource).toBe("finalize");
  });
});

describe("the signature", () => {
  it("is frozen at finalize, loads with the document, and survives the doctor replacing it", async () => {
    const original = Buffer.from([0, 9, 8, 7, 0, 255, 6, 5]);
    const firstSig = await insertImage("signature", original, 40, 20);
    await adminDb.update(doctors).set({ signatureAssetId: firstSig }).where(eq(doctors.userId, secondDoctorUserId));
    const id = await finalizedFor(await patient("Signed Person"), secondDoctor());

    const bundle = await load(id);
    expect(bundle.document.snapshot.doctor.signatureAssetId).toBe(firstSig);
    expect(bundle.signature?.base64).toBe(original.toString("base64"));

    const secondSig = await insertImage("signature", Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]), 41, 20);
    await adminDb.update(doctors).set({ signatureAssetId: secondSig }).where(eq(doctors.userId, secondDoctorUserId));
    const again = await load(id);
    expect(again.document.snapshot.doctor.signatureAssetId).toBe(firstSig);
    expect(again.signature?.base64).toBe(original.toString("base64"));
    await adminDb.update(doctors).set({ signatureAssetId: null }).where(eq(doctors.userId, secondDoctorUserId));
  });

  it("is never taken from a doctor profile in another clinic", async () => {
    // The user has a profile only in clinic B (B.as("doctor")) and finalizes in clinic A.
    const outsider: ServiceContext = { tenantId: A.tenantId, userId: B.as("doctor").userId, role: "doctor" };
    const { id, revision } = await savedDraftFor(await patient("Outsider Person"));
    expect((await finalizePrescription(outsider, id, { expectedRevision: revision })).ok).toBe(true);
    expect((await load(id)).document.snapshot.doctor).toMatchObject({ name: "", registrationNo: null, signatureAssetId: null });
  });
});

describe("version chains", () => {
  it("names the immediate successor of each superseded version", async () => {
    const v1 = await finalizedFor(await patient("Chain Person"));
    const a2 = await amendPrescription(doctor(), { prescriptionId: v1, reason: "First fix" });
    if (!a2.ok) throw new Error(a2.message);
    expect((await finalizeNow(doctor(), a2.value.prescriptionId)).ok).toBe(true);
    const a3 = await amendPrescription(doctor(), { prescriptionId: a2.value.prescriptionId, reason: "Second fix" });
    if (!a3.ok) throw new Error(a3.message);
    expect((await finalizeNow(doctor(), a3.value.prescriptionId)).ok).toBe(true);

    // An old version's banner names the next version; the chain leads on to the latest.
    expect((await load(v1)).document.supersededBy).toMatchObject({ version: 2 });
    expect((await load(a2.value.prescriptionId)).document.supersededBy).toMatchObject({ version: 3 });
    expect((await load(a3.value.prescriptionId)).document.supersededBy).toBeNull();
  });
});

describe("documents without a snapshot", () => {
  it("renders a draft with today's details, the visit's doctor, and no Rx number", async () => {
    const patientId = await patient("Draft Person");
    const started = await startPrescription(doctor(), { patientId });
    if (!started.ok) throw new Error(started.message);
    const bundle = await load(started.value.prescriptionId);
    expect(bundle.document).toMatchObject({ status: "draft", rxNo: null, issuedAt: null, snapshotSource: "live" });
    expect(bundle.document.snapshot.patient.name).toBe("Draft Person");
    expect(bundle.document.snapshot.doctor.name).toBe("Dr Snapshot");
  });

  it("renders a pre-1C finalized prescription from live data, aged on its own date, and says so", async () => {
    const patientId = await patient("Legacy Person", "2020-03-15");
    const id = await legacyFinalized(patientId, new Date("2026-11-12T10:00:00.000Z"));
    const bundle = await load(id);
    expect(bundle.document).toMatchObject({ status: "finalized", snapshotSource: "live", issuedAt: "2026-11-12T10:00:00.000Z" });
    expect(bundle.document.snapshot.patient.ageLabel).toBe("6 y");
    expect(bundle.document.snapshot.doctor.name).toBe("Dr Snapshot");
    expect(renderPrescription(bundle.document, NO_FONTS).html).toContain("finalized before print snapshots were recorded");
  });

  it("refuses to print a damaged snapshot instead of guessing", async () => {
    const patientId = await patient("Damaged Person");
    const id = await legacyFinalized(patientId, new Date(), { v: 99 });
    expect(await loadRxDocument(A.as("doctor"), id)).toMatchObject({ ok: false, code: "invalid" });
  });
});

describe("access", () => {
  it("lets every role with rx.read load a document and hides it from everyone else", async () => {
    const id = await finalizedFor(await patient("Access Person"));
    for (const role of ["owner", "doctor", "reception", "nurse", "pharmacist"]) {
      expect((await loadRxDocument(A.as(role), id)).ok).toBe(true);
    }
    expect(await loadRxDocument(A.as("accountant"), id)).toMatchObject({ ok: false, code: "forbidden" });
    expect(await loadRxDocument(B.as("doctor"), id)).toMatchObject({ ok: false, code: "not_found" });
    expect(await loadRxDocument(A.as("doctor"), newId())).toMatchObject({ ok: false, code: "not_found" });
    expect(await loadRxDocument(A.as("doctor"), "not-a-uuid")).toMatchObject({ ok: false, code: "not_found" });
    expect(await getVersionLinks(B.as("doctor"), id)).toMatchObject({ ok: false, code: "not_found" });
    expect(await getVersionLinks(A.as("accountant"), id)).toMatchObject({ ok: false, code: "forbidden" });
  });

  it("can skip loading image bytes", async () => {
    const id = await finalizedFor(await patient("No Assets Person"));
    const result = await loadRxDocument(A.as("doctor"), id, { withAssets: false });
    expect(result).toMatchObject({ ok: true, value: { logo: null, signature: null } });
  });
});
