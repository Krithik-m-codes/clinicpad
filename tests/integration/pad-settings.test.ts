// @vitest-environment node
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { adminDb } from "@/server/db/admin";
import { withTenant } from "@/server/db/tenant";
import { pgErrorInfo } from "@/server/db/errors";
import { auditEvents, clinicAssets, clinics, doctors, users } from "@/server/db/schema";
import {
  internalAttachClinicLogo,
  internalAttachDoctorSignature,
  getClinicPad,
  getDoctorProfile,
  getPadReadiness,
  setClinicLogo,
  setDoctorSignature,
  updateClinicPad,
  updateDoctorProfile,
} from "@/server/services/pad-settings";
import { primaryClinic } from "@/server/services/render-snapshot";
import { ASSET_CAPS } from "@/server/services/assets";
import { loadRxDocument } from "@/server/services/rx-documents";
import { createPatient } from "@/server/services/patients";
import { startPrescription } from "@/server/services/prescriptions";
import { NUL_MESSAGE } from "@/server/validation/text";
import { newId } from "@/lib/domain/ids";
import { JPEG_EXIF_GPS, JPEG_SOS, jpegWithSegments, makeJpegHeader, makePng, pngWithChunks } from "../helpers/images";
import { finalizeNow, saveDraftNow } from "../helpers/rx";
import { createTestTenant, type TestTenant } from "../helpers/tenant";

let A: TestTenant;
let B: TestTenant;

const pad = (overrides: Record<string, unknown> = {}) => ({
  name: "Sunrise Family Clinic",
  addressLine1: "12 MG Road",
  addressLine2: "",
  city: "Pune",
  state: "Maharashtra",
  pincode: "411001",
  phone: "020-2612 3456, 98200 12345",
  email: "",
  padFooter: "Mon-Sat 9 am to 1 pm\nBring old prescriptions",
  rxTemplate: "paediatric",
  rxPaperSize: "A5",
  rxLabels: "bilingual",
  ...overrides,
});

const auditFor = (tenantId: string, action: string) =>
  withTenant(tenantId, (tx) => tx.select().from(auditEvents).where(eq(auditEvents.action, action)));
const assets = (tenantId: string) => adminDb.select().from(clinicAssets).where(eq(clinicAssets.tenantId, tenantId));
const assetCount = async (tenantId: string) => (await assets(tenantId)).length;

beforeAll(async () => {
  // createTestTenant already inserts one clinic per tenant ("Test clinic <label>").
  A = await createTestTenant("pada");
  B = await createTestTenant("padb");
});

afterAll(async () => {
  await A.cleanup();
  await B.cleanup();
});

describe("clinic pad", () => {
  it("starts from the defaults", async () => {
    expect(await getClinicPad(A.as("owner"))).toMatchObject({
      ok: true,
      value: { name: "Test clinic pada", addressLine1: "", rxTemplate: "general", rxPaperSize: "A4", rxLabels: "en", logo: null },
    });
  });

  it("saves the pad, reports changed field names, and audits names only", async () => {
    const result = await updateClinicPad(A.as("owner"), pad());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.value.changedFields).toEqual(
      expect.arrayContaining(["name", "addressLine1", "city", "state", "pincode", "phone", "padFooter", "rxTemplate", "rxPaperSize", "rxLabels"]),
    );
    expect(await getClinicPad(A.as("owner"))).toMatchObject({
      ok: true,
      value: { name: "Sunrise Family Clinic", padFooter: "Mon-Sat 9 am to 1 pm\nBring old prescriptions", rxTemplate: "paediatric" },
    });
    const events = await auditFor(A.tenantId, "clinic.pad_updated");
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events[0])).not.toContain("12 MG Road");
    expect(JSON.stringify(events[0])).not.toContain("Sunrise");
  });

  it("is a no-op with no audit event when nothing changed", async () => {
    expect(await updateClinicPad(A.as("owner"), pad())).toMatchObject({ ok: true, value: { changedFields: [] } });
    expect(await auditFor(A.tenantId, "clinic.pad_updated")).toHaveLength(1);
  });

  it("stores markup verbatim, strips invisible characters, and refuses a NUL instead of dropping it", async () => {
    const name = "<script>alert(1)</script>\u202E";
    expect(name.codePointAt(name.length - 1)).toBe(0x202e);
    expect((await updateClinicPad(A.as("owner"), pad({ name }))).ok).toBe(true);
    expect(await getClinicPad(A.as("owner"))).toMatchObject({ ok: true, value: { name: "<script>alert(1)</script>" } });

    const withNul = "Clinic\u0000Name";
    expect(Array.from(withNul)).toHaveLength(11);
    expect(withNul.codePointAt(6)).toBe(0);
    expect(await updateClinicPad(A.as("owner"), pad({ name: withNul }))).toMatchObject({
      ok: false,
      code: "invalid",
      field: "name",
      message: NUL_MESSAGE,
    });
    expect(await updateClinicPad(A.as("owner"), pad({ padFooter: "Line one\u0000" }))).toMatchObject({ ok: false, field: "padFooter" });
  });

  it.each([
    [{ name: "X" }, "name"],
    [{ name: "" }, "name"],
    [{ name: "   \n " }, "name"],
    [{ name: "\u200B\u200B" }, "name"],
    [{ name: undefined }, "name"],
    [{ name: "n".repeat(121) }, "name"],
    [{ email: "not-an-email" }, "email"],
    [{ pincode: "4110@1" }, "pincode"],
    [{ phone: "9".repeat(81) }, "phone"],
    [{ padFooter: "1\n2\n3\n4\n5" }, "padFooter"],
    [{ padFooter: "x".repeat(601) }, "padFooter"],
    [{ rxTemplate: "fancy" }, "rxTemplate"],
    [{ rxPaperSize: "Letter" }, "rxPaperSize"],
    [{ rxLabels: "fr" }, "rxLabels"],
    [{ addressLine1: "a".repeat(201) }, "addressLine1"],
  ])("rejects %j", async (overrides, field) => {
    expect(await updateClinicPad(A.as("owner"), pad(overrides))).toMatchObject({ ok: false, code: "invalid", field });
  });

  it("accepts a phone of exactly 80 characters", async () => {
    expect((await updateClinicPad(A.as("owner"), pad({ phone: "9".repeat(80) }))).ok).toBe(true);
    await updateClinicPad(A.as("owner"), pad());
  });

  it.each(["doctor", "reception", "nurse", "pharmacist", "accountant"])("forbids %s", async (role) => {
    expect(await updateClinicPad(A.as(role), pad())).toMatchObject({ ok: false, code: "forbidden" });
    expect(await getClinicPad(A.as(role))).toMatchObject({ ok: false, code: "forbidden" });
    expect(await setClinicLogo(A.as(role), { bytes: new Uint8Array(makePng(64, 32)) })).toMatchObject({ ok: false, code: "forbidden" });
    expect(await setClinicLogo(A.as(role), null)).toMatchObject({ ok: false, code: "forbidden" });
  });

  it("changes only the caller's own clinic", async () => {
    await updateClinicPad(B.as("owner"), pad({ name: "Clinic B Renamed" }));
    expect(await getClinicPad(A.as("owner"))).toMatchObject({ ok: true, value: { name: "Sunrise Family Clinic" } });
  });
});

describe("clinic logo", () => {
  it("stores a PNG, shows it as a data URL, and de-duplicates a repeat upload", async () => {
    const png = makePng(120, 60);
    const bytes = new Uint8Array(png);
    const first = await setClinicLogo(A.as("owner"), { bytes });
    if (!first.ok) throw new Error(first.message);
    const before = await assetCount(A.tenantId);
    const again = await setClinicLogo(A.as("owner"), { bytes });
    expect(again).toMatchObject({ ok: true, value: { assetId: first.value.assetId } });
    expect(await assetCount(A.tenantId)).toBe(before);

    const view = await getClinicPad(A.as("owner"));
    expect(view.ok && view.value.logo?.dataUrl.startsWith("data:image/png;base64,")).toBe(true);
    expect(view.ok && view.value.logo).toMatchObject({ width: 120, height: 60 });

    // The hash is computed on the server from the stored bytes; the stored bytes are the upload.
    const [row] = await adminDb.select().from(clinicAssets).where(eq(clinicAssets.id, first.value.assetId as string));
    expect(row.sha256).toBe(createHash("sha256").update(png).digest("hex"));
    expect(Buffer.compare(row.bytes, png)).toBe(0);
    expect(row).toMatchObject({ kind: "logo", mime: "image/png", byteSize: png.length, createdBy: A.as("owner").userId });

    const events = await auditFor(A.tenantId, "clinic.logo_set");
    expect(events[0].after).toEqual({ assetId: first.value.assetId, byteSize: png.length, width: 120, height: 60 });
  });

  it("accepts a JPEG", async () => {
    expect((await setClinicLogo(A.as("owner"), { bytes: new Uint8Array(makeJpegHeader(300, 100)) })).ok).toBe(true);
  });

  it("stores no metadata: an EXIF JPEG and a text-chunk PNG are stripped before they are saved and hashed", async () => {
    const jpeg = jpegWithSegments(makeJpegHeader(310, 110), [JPEG_EXIF_GPS]);
    const png = pngWithChunks(makePng(77, 33), [{ type: "tEXt", data: Buffer.from("GPS  12.97 77.59", "latin1") }]);
    for (const [upload, marker] of [[jpeg, "Exif"], [png, "tEXt"]] as const) {
      const stored = await setClinicLogo(A.as("owner"), { bytes: new Uint8Array(upload) });
      if (!stored.ok) throw new Error(stored.message);
      const [row] = await adminDb.select().from(clinicAssets).where(eq(clinicAssets.id, stored.value.assetId as string));
      expect(row.bytes.includes(Buffer.from(marker, "latin1"))).toBe(false);
      expect(row.bytes.length).toBeLessThan(upload.length);
      expect(row.byteSize).toBe(row.bytes.length);
      expect(row.sha256).toBe(createHash("sha256").update(row.bytes).digest("hex"));
    }
    // The same picture with and without metadata is one asset (dedupe on the stripped hash).
    const clean = await setClinicLogo(A.as("owner"), { bytes: new Uint8Array(makeJpegHeader(310, 110)) });
    const withExif = await setClinicLogo(A.as("owner"), { bytes: new Uint8Array(jpeg) });
    expect(clean.ok && withExif.ok && clean.value.assetId === withExif.value.assetId).toBe(true);
  });

  it("keeps the same bytes as separate assets per kind", async () => {
    const bytes = new Uint8Array(makePng(90, 45));
    const logo = await setClinicLogo(A.as("owner"), { bytes });
    const signature = await setDoctorSignature(A.as("doctor"), { bytes });
    if (!logo.ok || !signature.ok) throw new Error("store failed");
    expect(logo.value.assetId).not.toBe(signature.value.assetId);
    await setDoctorSignature(A.as("doctor"), null);
  });

  it("removes the logo from the pad but keeps the asset for old prescriptions", async () => {
    const before = await assetCount(A.tenantId);
    expect(await setClinicLogo(A.as("owner"), null)).toEqual({ ok: true, value: { assetId: null } });
    expect(await getClinicPad(A.as("owner"))).toMatchObject({ ok: true, value: { logo: null } });
    expect(await assetCount(A.tenantId)).toBe(before);
    expect(await auditFor(A.tenantId, "clinic.logo_removed")).toHaveLength(1);
  });

  it.each([
    ["an SVG with a script", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>')],
    ["a PNG with a payload after IEND", Buffer.concat([makePng(64, 32), Buffer.from("<script>alert(1)</script>")])],
    ["a decompression bomb", makePng(5000, 16)],
    ["a truncated JPEG", makeJpegHeader(100, 100).subarray(0, 30)],
    ["a JPEG with a scan before its frame", Buffer.concat([Buffer.from([0xff, 0xd8]), JPEG_SOS, Buffer.from([0xff, 0xd9])])],
    ["an empty file", Buffer.alloc(0)],
    ["a 600 KB file", Buffer.concat([makePng(64, 32), Buffer.alloc(600 * 1024)])],
  ])("rejects %s and stores nothing", async (_label, input) => {
    const before = await assetCount(A.tenantId);
    const result = await setClinicLogo(A.as("owner"), { bytes: new Uint8Array(input) });
    expect(result).toMatchObject({ ok: false, code: "invalid", field: "image" });
    expect(await assetCount(A.tenantId)).toBe(before);
  });

  it("writes no audit event when the logo is already removed", async () => {
    await setClinicLogo(A.as("owner"), null);
    const events = (await auditFor(A.tenantId, "clinic.logo_removed")).length;
    expect(await setClinicLogo(A.as("owner"), null)).toEqual({ ok: true, value: { assetId: null } });
    expect(await auditFor(A.tenantId, "clinic.logo_removed")).toHaveLength(events);
  });

  it("keeps assets immutable for the application role", async () => {
    const error = await withTenant(A.tenantId, (tx) => tx.delete(clinicAssets)).then(
      () => null,
      (e: unknown) => e,
    );
    expect(pgErrorInfo(error).code).toBe("42501");
  });
});

describe("doctor profile", () => {
  const profile = (overrides: Record<string, unknown> = {}) => ({
    displayName: "Dr. Meera Shah",
    qualifications: "MBBS, MD (Medicine)",
    designation: "Consultant Physician",
    registrationNo: "MMC/2011/04-1234",
    registrationCouncil: "Maharashtra Medical Council",
    ...overrides,
  });

  it("reports what is missing for printing, then saves the profile", async () => {
    expect(await getPadReadiness(A.as("doctor"))).toEqual({ ok: true, value: { missing: ["doctorName", "registrationNo"] } });
    expect(await updateDoctorProfile(A.as("doctor"), profile())).toMatchObject({ ok: true });
    expect(await getDoctorProfile(A.as("owner"))).toMatchObject({
      ok: true,
      value: { displayName: "Dr. Meera Shah", registrationNo: "MMC/2011/04-1234", signature: null },
    });
    expect(await getPadReadiness(A.as("doctor"))).toEqual({ ok: true, value: { missing: [] } });
    const events = await auditFor(A.tenantId, "doctor.profile_updated");
    expect(JSON.stringify(events)).not.toContain("MMC/2011/04-1234");
    expect(JSON.stringify(events)).not.toContain("Meera");
  });

  it.each([
    [{ displayName: "D" }, "displayName"],
    [{ displayName: "" }, "displayName"],
    [{ registrationNo: "<b>123</b>" }, "registrationNo"],
    [{ registrationNo: "x".repeat(41) }, "registrationNo"],
    [{ qualifications: "q".repeat(201) }, "qualifications"],
  ])("rejects %j", async (overrides, field) => {
    expect(await updateDoctorProfile(A.as("doctor"), profile(overrides))).toMatchObject({ ok: false, code: "invalid", field });
  });

  it.each(["reception", "nurse", "pharmacist", "accountant"])("forbids %s", async (role) => {
    expect(await updateDoctorProfile(A.as(role), profile())).toMatchObject({ ok: false, code: "forbidden" });
    expect(await setDoctorSignature(A.as(role), null)).toMatchObject({ ok: false, code: "forbidden" });
    expect(await getDoctorProfile(A.as(role))).toMatchObject({ ok: false, code: "forbidden" });
  });

  it("tells non-prescribers nothing is missing", async () => {
    expect(await getPadReadiness(A.as("reception"))).toEqual({ ok: true, value: { missing: [] } });
  });

  it("tells a prescriber without a doctor profile that their pads print no doctor", async () => {
    const ownerWithoutProfile = { tenantId: A.tenantId, userId: newId(), role: "owner" };
    expect(await getPadReadiness(ownerWithoutProfile)).toEqual({ ok: true, value: { missing: ["noDoctorProfile"] } });
    expect(await getDoctorProfile(ownerWithoutProfile)).toMatchObject({ ok: false, code: "not_found" });
    expect(await setDoctorSignature(ownerWithoutProfile, null)).toMatchObject({ ok: false, code: "not_found" });
  });

  it("reports API field names in the audit event", async () => {
    await updateDoctorProfile(A.as("doctor"), profile({ registrationNo: "MMC/2011/04-9999" }));
    const events = await auditFor(A.tenantId, "doctor.profile_updated");
    const last = events[events.length - 1];
    expect(last.after).toEqual({ changedFields: ["registrationNo"] });
    await updateDoctorProfile(A.as("doctor"), profile());
  });

  it("edits only the caller's own doctor row (two doctors in one clinic)", async () => {
    const [second] = await adminDb
      .insert(users)
      .values({ email: `second-doc-${newId()}@example.com`, name: "Second", passwordHash: "not-a-real-hash" })
      .returning();
    try {
      await adminDb.insert(doctors).values({ tenantId: A.tenantId, userId: second.id });
      const secondCtx = { tenantId: A.tenantId, userId: second.id, role: "doctor" };
      expect((await updateDoctorProfile(secondCtx, profile({ displayName: "Dr. Second Doctor", registrationNo: "SEC-2" }))).ok).toBe(true);
      expect((await updateDoctorProfile(A.as("doctor"), profile({ displayName: "Dr. First Doctor", registrationNo: "FIR-1" }))).ok).toBe(true);
      const byUser = new Map((await adminDb.select().from(doctors).where(eq(doctors.tenantId, A.tenantId))).map((row) => [row.userId, row]));
      expect(byUser.get(second.id)).toMatchObject({ displayName: "Dr. Second Doctor", regNo: "SEC-2" });
      expect(byUser.get(A.as("doctor").userId)).toMatchObject({ displayName: "Dr. First Doctor", regNo: "FIR-1" });
      expect(await getDoctorProfile(secondCtx)).toMatchObject({ ok: true, value: { displayName: "Dr. Second Doctor" } });
    } finally {
      await adminDb.delete(doctors).where(eq(doctors.userId, second.id));
      await adminDb.delete(users).where(eq(users.id, second.id));
      await updateDoctorProfile(A.as("doctor"), profile());
    }
  });

  it("writes no audit event when a removal changes nothing", async () => {
    await setDoctorSignature(A.as("doctor"), null);
    const events = (await auditFor(A.tenantId, "doctor.signature_removed")).length;
    expect(await setDoctorSignature(A.as("doctor"), null)).toEqual({ ok: true, value: { assetId: null } });
    expect(await auditFor(A.tenantId, "doctor.signature_removed")).toHaveLength(events);
  });

  it("stores and removes a signature", async () => {
    const stored = await setDoctorSignature(A.as("doctor"), { bytes: new Uint8Array(makePng(200, 60)) });
    expect(stored.ok).toBe(true);
    expect(await getDoctorProfile(A.as("doctor"))).toMatchObject({ ok: true, value: { signature: { width: 200, height: 60 } } });
    expect(await auditFor(A.tenantId, "doctor.signature_set")).not.toHaveLength(0);
    expect(await setDoctorSignature(A.as("doctor"), null)).toEqual({ ok: true, value: { assetId: null } });
    expect(await auditFor(A.tenantId, "doctor.signature_removed")).not.toHaveLength(0);
  });

  it("rejects a bad signature image with the image field and stores nothing", async () => {
    const before = await assetCount(A.tenantId);
    const result = await setDoctorSignature(A.as("doctor"), { bytes: new Uint8Array(Buffer.from("<svg onload=alert(1)>")) });
    expect(result).toMatchObject({ ok: false, code: "invalid", field: "image" });
    expect(await assetCount(A.tenantId)).toBe(before);
  });
});

describe("asset kind is enforced on the write path", () => {
  async function ids() {
    const logo = await setClinicLogo(A.as("owner"), { bytes: new Uint8Array(makePng(70, 70, [1, 2, 3])) });
    const signature = await setDoctorSignature(A.as("doctor"), { bytes: new Uint8Array(makePng(71, 71, [4, 5, 6])) });
    if (!logo.ok || !signature.ok || !logo.value.assetId || !signature.value.assetId) throw new Error("store failed");
    return { logo: logo.value.assetId, signature: signature.value.assetId };
  }

  it("refuses to point the logo at a signature, and the signature at a logo", async () => {
    const { logo, signature } = await ids();
    const clinic = await withTenant(A.tenantId, (tx) => primaryClinic(tx, A.tenantId));
    const [doctor] = await adminDb.select().from(doctors).where(eq(doctors.userId, A.as("doctor").userId));
    if (!clinic) throw new Error("no clinic");

    expect(await withTenant(A.tenantId, (tx) => internalAttachClinicLogo(tx, A.tenantId, clinic.id, signature))).toMatchObject({
      ok: false,
      code: "invalid",
      field: "image",
    });
    expect(await withTenant(A.tenantId, (tx) => internalAttachDoctorSignature(tx, A.tenantId, doctor.id, logo))).toMatchObject({
      ok: false,
      code: "invalid",
      field: "image",
    });
    const [clinicRow] = await adminDb.select().from(clinics).where(eq(clinics.id, clinic.id));
    const [doctorRow] = await adminDb.select().from(doctors).where(eq(doctors.id, doctor.id));
    expect(clinicRow.logoAssetId).toBe(logo);
    expect(doctorRow.signatureAssetId).toBe(signature);

    // The right kinds attach.
    expect(await withTenant(A.tenantId, (tx) => internalAttachClinicLogo(tx, A.tenantId, clinic.id, logo))).toEqual({ ok: true, value: null });
    expect(await withTenant(A.tenantId, (tx) => internalAttachDoctorSignature(tx, A.tenantId, doctor.id, signature))).toEqual({ ok: true, value: null });
  });

  it("refuses an unknown id and another clinic's asset", async () => {
    const clinic = await withTenant(A.tenantId, (tx) => primaryClinic(tx, A.tenantId));
    if (!clinic) throw new Error("no clinic");
    const foreign = await setClinicLogo(B.as("owner"), { bytes: new Uint8Array(makePng(66, 66, [9, 9, 9])) });
    if (!foreign.ok || !foreign.value.assetId) throw new Error("store failed");
    const foreignId = foreign.value.assetId;
    expect(await withTenant(A.tenantId, (tx) => internalAttachClinicLogo(tx, A.tenantId, clinic.id, foreignId))).toMatchObject({ ok: false, code: "invalid" });
    expect(await withTenant(A.tenantId, (tx) => internalAttachClinicLogo(tx, A.tenantId, clinic.id, newId()))).toMatchObject({ ok: false, code: "invalid" });
  });
});

describe("a settings change does not touch finalized prescriptions", () => {
  it("keeps the frozen clinic name on a finalized pad while a draft follows the change", async () => {
    const C = await createTestTenant("padfrz");
    try {
      await updateClinicPad(C.as("owner"), pad({ name: "Old Clinic Name" }));
      const patient = await createPatient(C.as("reception"), { name: "Frozen Person" }, { allowDuplicate: true });
      if (!patient.ok) throw new Error(patient.message);
      const finalized = await startPrescription(C.as("doctor"), { patientId: patient.value.id });
      const draft = await startPrescription(C.as("doctor"), { patientId: patient.value.id });
      if (!finalized.ok || !draft.ok) throw new Error("start failed");
      for (const started of [finalized, draft]) {
        const saved = await saveDraftNow(C.as("doctor"), started.value.prescriptionId, { items: [{ drugName: "Paracetamol" }] });
        if (!saved.ok) throw new Error(saved.message);
      }
      const done = await finalizeNow(C.as("doctor"), finalized.value.prescriptionId);
      if (!done.ok) throw new Error(done.message);

      expect((await updateClinicPad(C.as("owner"), pad({ name: "New Clinic Name" }))).ok).toBe(true);

      const frozen = await loadRxDocument(C.as("doctor"), finalized.value.prescriptionId);
      expect(frozen).toMatchObject({ ok: true, value: { document: { snapshotSource: "finalize", snapshot: { clinic: { name: "Old Clinic Name" } } } } });
      const live = await loadRxDocument(C.as("doctor"), draft.value.prescriptionId);
      expect(live).toMatchObject({ ok: true, value: { document: { snapshotSource: "live", snapshot: { clinic: { name: "New Clinic Name" } } } } });
    } finally {
      await C.cleanup();
    }
  });
});

describe("per-clinic asset caps", () => {
  it("refuses a new image over the cap but still accepts a repeat of a stored one", async () => {
    const C = await createTestTenant("padcap");
    try {
      const logoCap = ASSET_CAPS.logo;
      expect(logoCap).toBe(20);
      expect(ASSET_CAPS.signature).toBe(50);
      let first: Uint8Array | null = null;
      for (let i = 0; i < logoCap; i += 1) {
        const bytes = new Uint8Array(makePng(40 + i, 20, [i, 1, 2]));
        first ??= bytes;
        const stored = await setClinicLogo(C.as("owner"), { bytes });
        if (!stored.ok) throw new Error(stored.message);
      }
      expect(await adminDb.select().from(clinicAssets).where(and(eq(clinicAssets.tenantId, C.tenantId), eq(clinicAssets.kind, "logo")))).toHaveLength(logoCap);

      const over = await setClinicLogo(C.as("owner"), { bytes: new Uint8Array(makePng(99, 20, [200, 1, 2])) });
      expect(over).toMatchObject({ ok: false, code: "invalid", field: "image" });
      expect(over.ok ? "" : over.message).toContain("20");
      expect(await adminDb.select().from(clinicAssets).where(and(eq(clinicAssets.tenantId, C.tenantId), eq(clinicAssets.kind, "logo")))).toHaveLength(logoCap);

      // Deduped re-upload at the cap does not count and succeeds.
      expect((await setClinicLogo(C.as("owner"), { bytes: first as Uint8Array })).ok).toBe(true);
      // The cap is per kind: a signature still stores.
      expect((await setDoctorSignature(C.as("doctor"), { bytes: new Uint8Array(makePng(50, 20, [7, 7, 7])) })).ok).toBe(true);
    } finally {
      await C.cleanup();
    }
  });
});

describe("audit scoping", () => {
  it("records settings events only in the acting clinic, with field names only", async () => {
    const events = await withTenant(B.tenantId, (tx) =>
      tx.select().from(auditEvents).where(and(eq(auditEvents.action, "clinic.pad_updated"), eq(auditEvents.tenantId, B.tenantId))),
    );
    expect(events).toHaveLength(1);
    expect(Object.keys(events[0].after ?? {})).toEqual(["changedFields"]);
    expect(JSON.stringify(events[0])).not.toContain("Clinic B Renamed");
  });
});
