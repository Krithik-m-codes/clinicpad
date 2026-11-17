import { asc, eq } from "drizzle-orm";
import { ageLabel } from "@/lib/domain/age";
import { clinics, doctors, patients } from "@/server/db/schema";
import type { TenantTx } from "@/server/db/tenant";
import type { RenderSnapshot } from "@/lib/rx-render/snapshot";
import { BUILTIN_TEMPLATES, LABEL_LANGUAGES, PAPER_SIZES, pickOption } from "@/lib/rx-render/types";

export type SnapshotSources = {
  patientId: string;
  /** The user who finalizes (or finalized) the prescription. When set, only their own doctor profile signs it. */
  prescriberUserId: string | null;
  /** The doctor the visit was opened for. Used only when nobody has finalized yet (a draft preview). */
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

/** The tenant's clinic profile (one per tenant today; the oldest if there are several). RLS scopes the read. */
export async function primaryClinic(tx: TenantTx): Promise<ClinicRow | null> {
  const [row] = await tx.select().from(clinics).orderBy(asc(clinics.createdAt), asc(clinics.id)).limit(1);
  return row ?? null;
}

/**
 * Who signs the pad (ADR-0032). Whoever finalized signs it, and nobody else: never fall back to the
 * visit's doctor, whose name and signature would then appear on a prescription they did not sign
 * (an amendment keeps the original visit's doctor_id). Only a draft (no finalizer yet) previews with
 * the visit's doctor.
 */
async function prescribingDoctor(tx: TenantTx, sources: SnapshotSources) {
  if (sources.prescriberUserId) {
    const [byUser] = await tx.select().from(doctors).where(eq(doctors.userId, sources.prescriberUserId)).limit(1);
    return byUser ?? null;
  }
  if (sources.visitDoctorId) {
    const [byId] = await tx.select().from(doctors).where(eq(doctors.id, sources.visitDoctorId)).limit(1);
    return byId ?? null;
  }
  return null;
}

/**
 * Everything the printed pad shows that is not clinical content. Finalize stores it in
 * prescriptions.render_snapshot so a reprint never picks up later edits (ADR-0032).
 * Call it only inside withTenant(): RLS scopes every read here (the clinic lookup takes the
 * tenant's first clinic), so on the admin connection it would read other tenants' rows.
 * The age uses ageLabel's UTC calendar day (clinic-timezone ages are a Plan 1D follow-up).
 */
export async function buildRenderSnapshot(tx: TenantTx, sources: SnapshotSources): Promise<RenderSnapshot> {
  const [patient] = await tx
    .select({
      name: patients.name,
      patientNo: patients.patientNo,
      gender: patients.gender,
      dob: patients.dob,
      allergies: patients.allergies,
    })
    .from(patients)
    .where(eq(patients.id, sources.patientId))
    .limit(1);
  const clinic = await primaryClinic(tx);
  const doctor = await prescribingDoctor(tx, sources);

  return {
    v: 1,
    takenAt: sources.at.toISOString(),
    patient: {
      name: patient?.name ?? "",
      patientNo: patient?.patientNo ?? null,
      gender: patient?.gender ?? null,
      dob: patient?.dob ?? null,
      ageLabel: patient?.dob ? ageLabel(patient.dob, sources.at) : "",
      allergies: patient?.allergies ?? [],
    },
    clinic: {
      name: clinic?.name ?? "",
      addressLines: clinic ? addressLines(clinic) : [],
      phone: clinic?.phone ?? null,
      email: clinic?.email ?? null,
      footerLines: footerLines(clinic?.padFooter ?? null),
      logoAssetId: clinic?.logoAssetId ?? null,
      timezone: clinic?.timezone ?? "Asia/Kolkata",
    },
    doctor: {
      name: doctor?.displayName ?? "",
      qualifications: doctor?.qualifications ?? null,
      designation: doctor?.designation ?? null,
      registrationNo: doctor?.regNo ?? null,
      registrationCouncil: doctor?.registrationCouncil ?? null,
      signatureAssetId: doctor?.signatureAssetId ?? null,
    },
    layout: {
      template: { kind: "builtin", key: pickOption(BUILTIN_TEMPLATES, clinic?.rxTemplate, "general") },
      paperSize: pickOption(PAPER_SIZES, clinic?.rxPaperSize, "A4"),
      labels: pickOption(LABEL_LANGUAGES, clinic?.rxLabels, "en"),
    },
  };
}
