import { and, asc, eq } from "drizzle-orm";
import { ageLabel } from "@/lib/domain/age";
import { clinics, doctors, patients } from "@/server/db/schema";
import type { TenantTx } from "@/server/db/tenant";
import { fail, ok, type Result } from "@/lib/result";
import { DEFAULT_TIME_ZONE } from "@/lib/rx-render/format";
import { parseRenderSnapshot, snapshotWithLayout, type RenderSnapshot } from "@/lib/rx-render/snapshot";
import type { PadLayout } from "@/lib/rx-render/types";
import { clinicLocalDate } from "@/lib/domain/clinic-date";
import { builtinLayout, resolveTemplateIn } from "./template-resolution";

// Moved to src/lib/domain/clinic-date.ts (Plan 1D); re-exported for existing importers.
export { clinicLocalDate };

export type SnapshotSources = {
  /** The caller's tenant (from the session). Every read here filters on it, on top of row-level security. */
  tenantId: string;
  patientId: string;
  /** The user who finalizes (or finalized) the prescription. When set, only their own doctor profile signs it. */
  prescriberUserId: string | null;
  /** The doctor the visit was opened for. Used only when no prescriber is given; draft previews pass null (the viewer is the would-be signer). */
  visitDoctorId: string | null;
  /** The prescription's date: finalize time, or now for a draft. Age is computed for this day. */
  at: Date;
};

type ClinicRow = typeof clinics.$inferSelect;

function nonEmpty(values: (string | null | undefined)[]): string[] {
  return values.map((v) => (v ?? "").trim()).filter((v) => v !== "");
}

export function addressLines(clinic: Pick<ClinicRow, "addressLine1" | "addressLine2" | "city" | "state" | "pincode">): string[] {
  const place = nonEmpty([clinic.city, clinic.state]).join(", ");
  const pin = (clinic.pincode ?? "").trim();
  const last = pin ? (place ? `${place} - ${pin}` : pin) : place;
  return nonEmpty([clinic.addressLine1, clinic.addressLine2, last]);
}

/** Up to four non-empty, trimmed footer lines. */
export function footerLines(text: string | null): string[] {
  return nonEmpty((text ?? "").split("\n")).slice(0, 4);
}

/** The tenant's clinic profile (one per tenant today; the oldest if there are several). */
export async function primaryClinic(tx: TenantTx, tenantId: string, lock = false): Promise<ClinicRow | null> {
  const query = tx
    .select()
    .from(clinics)
    .where(eq(clinics.tenantId, tenantId))
    .orderBy(asc(clinics.createdAt), asc(clinics.id))
    .limit(1);
  const [row] = await (lock ? query.for("update") : query);
  return row ?? null;
}

/**
 * Who signs the pad (ADR-0032). Whoever finalized signs it, and nobody else: never fall back to the
 * visit's doctor, whose name and signature would then appear on a prescription they did not sign
 * (an amendment keeps the original visit's doctor_id). Only a draft (no finalizer yet) previews with
 * the visit's doctor.
 */
async function prescribingDoctor(tx: TenantTx, sources: SnapshotSources) {
  if (sources.prescriberUserId !== null) {
    const [byUser] = await tx
      .select()
      .from(doctors)
      .where(and(eq(doctors.tenantId, sources.tenantId), eq(doctors.userId, sources.prescriberUserId)))
      .limit(1);
    return byUser ?? null;
  }
  if (sources.visitDoctorId !== null) {
    const [byId] = await tx
      .select()
      .from(doctors)
      .where(and(eq(doctors.tenantId, sources.tenantId), eq(doctors.id, sources.visitDoctorId)))
      .limit(1);
    return byId ?? null;
  }
  return null;
}

async function gather(tx: TenantTx, sources: SnapshotSources) {
  const [patient] = await tx
    .select({
      name: patients.name,
      patientNo: patients.patientNo,
      gender: patients.gender,
      dob: patients.dob,
      allergies: patients.allergies,
    })
    .from(patients)
    .where(and(eq(patients.tenantId, sources.tenantId), eq(patients.id, sources.patientId)))
    .limit(1);
  const clinic = await primaryClinic(tx, sources.tenantId);
  const doctor = await prescribingDoctor(tx, sources);
  return { patient: patient ?? null, clinic, doctor };
}

type Gathered = Awaited<ReturnType<typeof gather>>;

function compose(found: Gathered, at: Date, layout: PadLayout): RenderSnapshot {
  const { patient, clinic, doctor } = found;
  const timezone = clinic?.timezone ?? DEFAULT_TIME_ZONE;
  const base = {
    takenAt: at.toISOString(),
    patient: {
      name: patient?.name ?? "",
      patientNo: patient?.patientNo ?? null,
      gender: patient?.gender ?? null,
      dob: patient?.dob ?? null,
      // Aged on the clinic's own calendar day, the same day the printed date shows.
      ageLabel: patient?.dob ? ageLabel(patient.dob, clinicLocalDate(at, timezone)) : "",
      allergies: patient?.allergies ?? [],
    },
    clinic: {
      name: clinic?.name ?? "",
      addressLines: clinic ? addressLines(clinic) : [],
      phone: clinic?.phone ?? null,
      email: clinic?.email ?? null,
      footerLines: footerLines(clinic?.padFooter ?? null),
      logoAssetId: clinic?.logoAssetId ?? null,
      timezone,
    },
    doctor: {
      name: doctor?.displayName ?? "",
      qualifications: doctor?.qualifications ?? null,
      designation: doctor?.designation ?? null,
      registrationNo: doctor?.regNo ?? null,
      registrationCouncil: doctor?.registrationCouncil ?? null,
      signatureAssetId: doctor?.signatureAssetId ?? null,
    },
  };
  // Built-in pads freeze as version 1 (unchanged shape); only a custom overlay pad is version 2 (Plan 2A override 4).
  return snapshotWithLayout(base, layout);
}

/**
 * Everything the printed pad shows that is not clinical content, for previews (drafts) and for
 * prescriptions finalized before snapshots existed: missing rows give empty blocks. Every read filters on
 * `sources.tenantId` on top of row-level security. Call it only inside withTenant().
 */
export async function buildRenderSnapshot(tx: TenantTx, sources: SnapshotSources): Promise<RenderSnapshot> {
  const found = await gather(tx, sources);
  return compose(found, sources.at, builtinLayout(found.clinic));
}

/**
 * The snapshot finalize freezes into the record (ADR-0032, ADR-0045), or `invalid` when it cannot be a faithful one:
 * the patient or the clinic profile is missing, a stored value is unprintable, or the signer's pad template is damaged.
 * The pad is resolved for the finalizing doctor (template-resolution.ts). Nothing here allocates or writes.
 */
export async function buildFinalSnapshot(tx: TenantTx, sources: SnapshotSources): Promise<Result<RenderSnapshot>> {
  const found = await gather(tx, sources);
  if (!found.patient) return fail("invalid", "The patient record could not be read, so the prescription cannot be finalized.");
  if (!found.clinic) {
    return fail("invalid", "Set up the clinic profile (name and address) before finalizing prescriptions.");
  }
  const layout = await resolveTemplateIn(tx, sources.tenantId, found.clinic, found.doctor);
  if (!layout.ok) return layout;
  const snapshot = parseRenderSnapshot(compose(found, sources.at, layout.value));
  if (!snapshot) {
    return fail(
      "invalid",
      "The patient, clinic, or doctor details cannot be printed as they are. Check the clinic profile and the patient record, then finalize again.",
    );
  }
  return ok(snapshot);
}

/** A draft's preview snapshot with the pad its would-be signer would get (spec section 5.3). Call it only inside withTenant(). */
export async function buildDraftSnapshot(tx: TenantTx, sources: SnapshotSources): Promise<Result<RenderSnapshot>> {
  const found = await gather(tx, sources);
  const layout = await resolveTemplateIn(tx, sources.tenantId, found.clinic, found.doctor);
  if (!layout.ok) return layout;
  return ok(compose(found, sources.at, layout.value));
}
