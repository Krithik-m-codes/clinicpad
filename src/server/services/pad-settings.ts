import { and, eq } from "drizzle-orm";
import { fail, invalidFrom, ok, type Result } from "@/lib/result";
import { can } from "@/lib/domain/permissions";
import { inspectImage, stripImageMetadata } from "@/lib/domain/image";
import type { MalwareScanner } from "@/server/scanning/scanner";
import { scanOrRefuse } from "@/server/scanning/uploads";
import { clinics, doctors } from "@/server/db/schema";
import { withTenant, type TenantTx } from "@/server/db/tenant";
import {
  BUILTIN_TEMPLATES,
  LABEL_LANGUAGES,
  PAPER_SIZES,
  pickOption,
  type BuiltinTemplateKey,
  type LabelLanguage,
  type PaperSize,
} from "@/lib/rx-render/types";
import { clinicPadSchema, doctorProfileSchema } from "@/server/validation/pad-settings";
import type { ServiceContext } from "./context";
import { recordAudit } from "./audit";
import { assetHasKind, assetKey, assetPreview, loadImageAssets, storeImageAsset, type AssetKind, type AssetPreview } from "./assets";
import { primaryClinic } from "./render-snapshot";

export type ClinicPadView = {
  name: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  state: string;
  pincode: string;
  phone: string;
  email: string;
  padFooter: string;
  rxTemplate: BuiltinTemplateKey;
  rxPaperSize: PaperSize;
  rxLabels: LabelLanguage;
  logo: AssetPreview | null;
};

export type DoctorProfileView = {
  displayName: string;
  qualifications: string;
  designation: string;
  registrationNo: string;
  registrationCouncil: string;
  signature: AssetPreview | null;
};

/** What a prescriber's printed pads would lack. "noDoctorProfile": the user has no doctor row in this clinic at all. */
export type ProfileGap = "noDoctorProfile" | "doctorName" | "registrationNo";
export type UploadedImage = { bytes: Uint8Array };

const CLINIC_FORBIDDEN = "Only the clinic owner can change the prescription pad.";
const PROFILE_FORBIDDEN = "Only doctors can edit a doctor profile.";
const NO_CLINIC = () => fail("not_found", "Clinic not found.");
const NO_DOCTOR = () => fail("not_found", "You do not have a doctor profile in this clinic.");
const WRONG_KIND = (kind: AssetKind) => fail("invalid", `That file is not a ${kind} image.`, "image");

/** Keys of `next` that differ from `current`, reported under their API names (`apiNames` maps database keys that differ). */
function changedFields(current: Record<string, unknown>, next: Record<string, unknown>, apiNames: Record<string, string> = {}): string[] {
  return Object.keys(next)
    .filter((key) => JSON.stringify(next[key] ?? null) !== JSON.stringify(current[key] ?? null))
    .map((key) => apiNames[key] ?? key);
}

async function ownDoctor(tx: TenantTx, tenantId: string, userId: string, lock = false) {
  const query = tx
    .select()
    .from(doctors)
    .where(and(eq(doctors.tenantId, tenantId), eq(doctors.userId, userId)))
    .limit(1);
  const [row] = await (lock ? query.for("update") : query);
  return row ?? null;
}

async function preview(tx: TenantTx, tenantId: string, kind: AssetKind, assetId: string | null): Promise<AssetPreview | null> {
  if (!assetId) return null;
  const asset = (await loadImageAssets(tx, tenantId, [{ id: assetId, kind }])).get(assetKey(kind, assetId));
  return asset ? assetPreview(assetId, asset) : null;
}

export async function getClinicPad(ctx: ServiceContext): Promise<Result<ClinicPadView>> {
  if (!can(ctx.role, "settings.clinic")) return fail("forbidden", CLINIC_FORBIDDEN);
  return withTenant(ctx.tenantId, async (tx): Promise<Result<ClinicPadView>> => {
    const clinic = await primaryClinic(tx, ctx.tenantId);
    if (!clinic) return NO_CLINIC();
    return ok({
      name: clinic.name,
      addressLine1: clinic.addressLine1 ?? "",
      addressLine2: clinic.addressLine2 ?? "",
      city: clinic.city ?? "",
      state: clinic.state ?? "",
      pincode: clinic.pincode ?? "",
      phone: clinic.phone ?? "",
      email: clinic.email ?? "",
      padFooter: clinic.padFooter ?? "",
      rxTemplate: pickOption(BUILTIN_TEMPLATES, clinic.rxTemplate, "general"),
      rxPaperSize: pickOption(PAPER_SIZES, clinic.rxPaperSize, "A4"),
      rxLabels: pickOption(LABEL_LANGUAGES, clinic.rxLabels, "en"),
      logo: await preview(tx, ctx.tenantId, "logo", clinic.logoAssetId),
    });
  });
}

export async function updateClinicPad(ctx: ServiceContext, raw: unknown): Promise<Result<{ changedFields: string[] }>> {
  if (!can(ctx.role, "settings.clinic")) return fail("forbidden", CLINIC_FORBIDDEN);
  const parsed = clinicPadSchema.safeParse(raw);
  if (!parsed.success) return invalidFrom(parsed.error);
  const input = parsed.data;
  const next = {
    name: input.name,
    addressLine1: input.addressLine1 ?? null,
    addressLine2: input.addressLine2 ?? null,
    city: input.city ?? null,
    state: input.state ?? null,
    pincode: input.pincode ?? null,
    phone: input.phone ?? null,
    email: input.email ?? null,
    padFooter: input.padFooter ?? null,
    rxTemplate: input.rxTemplate,
    rxPaperSize: input.rxPaperSize,
    rxLabels: input.rxLabels,
  };

  return withTenant(ctx.tenantId, async (tx): Promise<Result<{ changedFields: string[] }>> => {
    const clinic = await primaryClinic(tx, ctx.tenantId, true);
    if (!clinic) return NO_CLINIC();
    const changed = changedFields(clinic, next);
    if (changed.length === 0) return ok({ changedFields: [] });
    await tx.update(clinics).set(next).where(and(eq(clinics.tenantId, ctx.tenantId), eq(clinics.id, clinic.id)));
    await recordAudit(tx, ctx, { action: "clinic.pad_updated", entityType: "clinic", entityId: clinic.id, after: { changedFields: changed } });
    return ok({ changedFields: changed });
  });
}

/**
 * INTERNAL: exported only so tests can pin the kind check; the public way to set a logo is setClinicLogo.
 * Points the clinic's logo at an existing asset after checking it is a `logo` of this tenant (the composite
 * foreign key checks the tenant and the id, not the kind). Call inside withTenant().
 */
export async function internalAttachClinicLogo(tx: TenantTx, tenantId: string, clinicId: string, assetId: string): Promise<Result<null>> {
  if (!(await assetHasKind(tx, tenantId, assetId, "logo"))) return WRONG_KIND("logo");
  await tx.update(clinics).set({ logoAssetId: assetId }).where(and(eq(clinics.tenantId, tenantId), eq(clinics.id, clinicId)));
  return ok(null);
}

/** As internalAttachClinicLogo, for a doctor's signature. */
export async function internalAttachDoctorSignature(tx: TenantTx, tenantId: string, doctorId: string, assetId: string): Promise<Result<null>> {
  if (!(await assetHasKind(tx, tenantId, assetId, "signature"))) return WRONG_KIND("signature");
  await tx.update(doctors).set({ signatureAssetId: assetId }).where(and(eq(doctors.tenantId, tenantId), eq(doctors.id, doctorId)));
  return ok(null);
}

type ScannedImage = { bytes: Uint8Array; engine: string };

/**
 * Bytes that are not an image are refused without a scan. An image is stripped of metadata and re-inspected, then
 * scanned (the original too) before any transaction opens; the stripped bytes are what the caller stores, so the
 * stored bytes are exactly bytes the scanner saw (stripping is idempotent, storeImageAsset strips again to the same).
 */
async function scanImage(ctx: ServiceContext, image: UploadedImage, entityType: string, kind: string, scanner?: MalwareScanner): Promise<Result<ScannedImage>> {
  const precheck = inspectImage(image.bytes);
  if (!precheck.ok) return fail("invalid", precheck.message, "image");
  const stripped = stripImageMetadata(image.bytes);
  const check = stripped ? inspectImage(stripped) : null;
  if (!stripped || !check?.ok) {
    await withTenant(ctx.tenantId, (tx) =>
      recordAudit(tx, ctx, { action: "upload.rejected", entityType, after: { kind, reasonCode: "damaged", byteSize: image.bytes.length } }),
    );
    return fail("invalid", "The image file is damaged. Export it again as a PNG or JPEG.", "image");
  }
  const audit = { action: "upload.rejected", entityType, kind, field: "image" };
  const original = await scanOrRefuse(ctx, image.bytes, audit, scanner);
  if (!original.ok) return original;
  const same = Buffer.compare(Buffer.from(stripped), Buffer.from(image.bytes)) === 0;
  const scanned = same ? original : await scanOrRefuse(ctx, stripped, audit, scanner);
  return scanned.ok ? ok({ bytes: stripped, engine: scanned.value.engine }) : scanned;
}

export async function setClinicLogo(
  ctx: ServiceContext,
  image: UploadedImage | null,
  deps: { scanner?: MalwareScanner } = {},
): Promise<Result<{ assetId: string | null }>> {
  if (!can(ctx.role, "settings.clinic")) return fail("forbidden", CLINIC_FORBIDDEN);
  let scanned: ScannedImage | null = null;
  if (image !== null) {
    const result = await scanImage(ctx, image, "clinic", "logo", deps.scanner);
    if (!result.ok) return result;
    scanned = result.value;
  }
  return withTenant(ctx.tenantId, async (tx): Promise<Result<{ assetId: string | null }>> => {
    const clinic = await primaryClinic(tx, ctx.tenantId);
    if (!clinic) return NO_CLINIC();
    if (image === null || scanned === null) {
      if (clinic.logoAssetId === null) return ok({ assetId: null });
      await tx.update(clinics).set({ logoAssetId: null }).where(and(eq(clinics.tenantId, ctx.tenantId), eq(clinics.id, clinic.id)));
      await recordAudit(tx, ctx, { action: "clinic.logo_removed", entityType: "clinic", entityId: clinic.id });
      return ok({ assetId: null });
    }
    const stored = await storeImageAsset(tx, ctx, "logo", scanned.bytes);
    if (!stored.ok) return stored;
    const attached = await internalAttachClinicLogo(tx, ctx.tenantId, clinic.id, stored.value.id);
    if (!attached.ok) return attached;
    await recordAudit(tx, ctx, {
      action: "clinic.logo_set",
      entityType: "clinic",
      entityId: clinic.id,
      after: { assetId: stored.value.id, byteSize: stored.value.byteSize, width: stored.value.width, height: stored.value.height, scanEngine: scanned.engine },
    });
    return ok({ assetId: stored.value.id });
  });
}

export async function getDoctorProfile(ctx: ServiceContext): Promise<Result<DoctorProfileView>> {
  if (!can(ctx.role, "settings.profile")) return fail("forbidden", PROFILE_FORBIDDEN);
  return withTenant(ctx.tenantId, async (tx): Promise<Result<DoctorProfileView>> => {
    const doctor = await ownDoctor(tx, ctx.tenantId, ctx.userId);
    if (!doctor) return NO_DOCTOR();
    return ok({
      displayName: doctor.displayName ?? "",
      qualifications: doctor.qualifications ?? "",
      designation: doctor.designation ?? "",
      registrationNo: doctor.regNo ?? "",
      registrationCouncil: doctor.registrationCouncil ?? "",
      signature: await preview(tx, ctx.tenantId, "signature", doctor.signatureAssetId),
    });
  });
}

export async function updateDoctorProfile(ctx: ServiceContext, raw: unknown): Promise<Result<{ changedFields: string[] }>> {
  if (!can(ctx.role, "settings.profile")) return fail("forbidden", PROFILE_FORBIDDEN);
  const parsed = doctorProfileSchema.safeParse(raw);
  if (!parsed.success) return invalidFrom(parsed.error);
  const input = parsed.data;
  const next = {
    displayName: input.displayName,
    qualifications: input.qualifications ?? null,
    designation: input.designation ?? null,
    regNo: input.registrationNo ?? null,
    registrationCouncil: input.registrationCouncil ?? null,
  };

  return withTenant(ctx.tenantId, async (tx): Promise<Result<{ changedFields: string[] }>> => {
    const doctor = await ownDoctor(tx, ctx.tenantId, ctx.userId, true);
    if (!doctor) return NO_DOCTOR();
    const changed = changedFields(doctor, next, { regNo: "registrationNo" });
    if (changed.length === 0) return ok({ changedFields: [] });
    await tx.update(doctors).set(next).where(and(eq(doctors.tenantId, ctx.tenantId), eq(doctors.id, doctor.id)));
    await recordAudit(tx, ctx, { action: "doctor.profile_updated", entityType: "doctor", entityId: doctor.id, after: { changedFields: changed } });
    return ok({ changedFields: changed });
  });
}

export async function setDoctorSignature(
  ctx: ServiceContext,
  image: UploadedImage | null,
  deps: { scanner?: MalwareScanner } = {},
): Promise<Result<{ assetId: string | null }>> {
  if (!can(ctx.role, "settings.profile")) return fail("forbidden", PROFILE_FORBIDDEN);
  let scanned: ScannedImage | null = null;
  if (image !== null) {
    const result = await scanImage(ctx, image, "doctor", "signature", deps.scanner);
    if (!result.ok) return result;
    scanned = result.value;
  }
  return withTenant(ctx.tenantId, async (tx): Promise<Result<{ assetId: string | null }>> => {
    const doctor = await ownDoctor(tx, ctx.tenantId, ctx.userId);
    if (!doctor) return NO_DOCTOR();
    if (image === null || scanned === null) {
      if (doctor.signatureAssetId === null) return ok({ assetId: null });
      await tx.update(doctors).set({ signatureAssetId: null }).where(and(eq(doctors.tenantId, ctx.tenantId), eq(doctors.id, doctor.id)));
      await recordAudit(tx, ctx, { action: "doctor.signature_removed", entityType: "doctor", entityId: doctor.id });
      return ok({ assetId: null });
    }
    const stored = await storeImageAsset(tx, ctx, "signature", scanned.bytes);
    if (!stored.ok) return stored;
    const attached = await internalAttachDoctorSignature(tx, ctx.tenantId, doctor.id, stored.value.id);
    if (!attached.ok) return attached;
    await recordAudit(tx, ctx, {
      action: "doctor.signature_set",
      entityType: "doctor",
      entityId: doctor.id,
      after: { assetId: stored.value.id, byteSize: stored.value.byteSize, width: stored.value.width, height: stored.value.height, scanEngine: scanned.engine },
    });
    return ok({ assetId: stored.value.id });
  });
}

/**
 * What the signed-in prescriber's printed pads would lack (the pad is signed by whoever finalizes, ADR-0032).
 * Non-prescribers lack nothing. An owner may have no doctor row at all: finalize still works, so say so.
 */
export async function getPadReadiness(ctx: ServiceContext): Promise<Result<{ missing: ProfileGap[] }>> {
  if (!can(ctx.role, "rx.draft")) return ok({ missing: [] });
  return withTenant(ctx.tenantId, async (tx) => {
    const doctor = await ownDoctor(tx, ctx.tenantId, ctx.userId);
    const missing: ProfileGap[] = [];
    if (!doctor) {
      missing.push("noDoctorProfile");
    } else {
      if (!doctor.displayName?.trim()) missing.push("doctorName");
      if (!doctor.regNo?.trim()) missing.push("registrationNo");
    }
    return ok({ missing });
  });
}
