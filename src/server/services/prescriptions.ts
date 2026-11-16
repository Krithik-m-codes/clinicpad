import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { fail, invalidFrom, ok, type Result } from "@/lib/result";
import { can } from "@/lib/domain/permissions";
import { isUuid } from "@/lib/domain/ids";
import { doctors, patients, prescriptionItems, prescriptions, visits } from "@/server/db/schema";
import { pgErrorInfo } from "@/server/db/errors";
import { withTenant, type TenantTx } from "@/server/db/tenant";
import { draftInputSchema, type DraftItemInput } from "@/server/validation/prescription";
import type { ServiceContext } from "./context";
import { recordAudit } from "./audit";

export type ItemView = {
  drugName: string;
  strength: string | null;
  form: string | null;
  route: string | null;
  dose: string | null;
  timing: string | null;
  foodRelation: string | null;
  durationDays: number | null;
  remarks: string | null;
};

export type PrescriptionView = {
  id: string;
  status: string;
  version: number;
  rxNo: number | null;
  amendmentReason: string | null;
  parentPrescriptionId: string | null;
  finalizedAt: Date | null;
  patient: { id: string; name: string; patientNo: number | null };
  visit: {
    id: string;
    visitType: string;
    chiefComplaint: string | null;
    diagnosis: string[];
    advice: string | null;
    followUpDate: string | null;
  };
  items: ItemView[];
};

export type PrescriptionSummary = {
  id: string;
  rxNo: number | null;
  version: number;
  status: string;
  chiefComplaint: string | null;
  createdAt: Date;
  finalizedAt: Date | null;
};

const prescriptionNotFound = () => fail("not_found", "Prescription not found.");
const patientNotFound = () => fail("not_found", "Patient not found.");

async function doctorIdFor(tx: TenantTx, userId: string): Promise<string | null> {
  const [doctor] = await tx.select({ id: doctors.id }).from(doctors).where(eq(doctors.userId, userId)).limit(1);
  return doctor?.id ?? null;
}

/** Copies items (used by amend and repeat). Items are inserted while the target is a draft. */
export async function copyItems(
  tx: TenantTx,
  ctx: ServiceContext,
  fromPrescriptionId: string,
  toPrescriptionId: string,
): Promise<void> {
  const rows = await tx
    .select()
    .from(prescriptionItems)
    .where(eq(prescriptionItems.prescriptionId, fromPrescriptionId))
    .orderBy(asc(prescriptionItems.sortOrder));
  if (rows.length === 0) return;
  await tx.insert(prescriptionItems).values(
    rows.map((r) => ({
      tenantId: ctx.tenantId,
      prescriptionId: toPrescriptionId,
      sortOrder: r.sortOrder,
      drugName: r.drugName,
      strength: r.strength,
      form: r.form,
      route: r.route,
      dose: r.dose,
      timing: r.timing,
      foodRelation: r.foodRelation,
      durationDays: r.durationDays,
      remarks: r.remarks,
    })),
  );
}

export async function startPrescription(
  ctx: ServiceContext,
  input: { patientId: string },
): Promise<Result<{ prescriptionId: string }>> {
  if (!can(ctx.role, "rx.draft")) return fail("forbidden", "Only doctors can write prescriptions.");
  if (!isUuid(input.patientId)) return patientNotFound();

  return withTenant(ctx.tenantId, async (tx) => {
    const [patient] = await tx
      .select({ id: patients.id })
      .from(patients)
      .where(and(eq(patients.id, input.patientId), isNull(patients.deletedAt)))
      .limit(1);
    if (!patient) return patientNotFound();

    const [visit] = await tx
      .insert(visits)
      .values({
        tenantId: ctx.tenantId,
        patientId: patient.id,
        doctorId: await doctorIdFor(tx, ctx.userId),
        status: "draft",
        visitType: "new",
      })
      .returning({ id: visits.id });
    const [rx] = await tx
      .insert(prescriptions)
      .values({ tenantId: ctx.tenantId, visitId: visit.id, status: "draft", version: 1 })
      .returning({ id: prescriptions.id });
    await recordAudit(tx, ctx, {
      action: "prescription.drafted",
      entityType: "prescription",
      entityId: rx.id,
      after: { version: 1 },
    });
    return ok({ prescriptionId: rx.id });
  });
}

export async function getPrescription(ctx: ServiceContext, id: string): Promise<Result<PrescriptionView>> {
  if (!can(ctx.role, "rx.read")) return fail("forbidden", "You cannot view prescriptions.");
  if (!isUuid(id)) return prescriptionNotFound();

  return withTenant(ctx.tenantId, async (tx) => {
    const [row] = await tx
      .select({
        rx: prescriptions,
        visit: visits,
        patient: { id: patients.id, name: patients.name, patientNo: patients.patientNo },
      })
      .from(prescriptions)
      .innerJoin(visits, eq(visits.id, prescriptions.visitId))
      .innerJoin(patients, eq(patients.id, visits.patientId))
      .where(eq(prescriptions.id, id))
      .limit(1);
    if (!row) return prescriptionNotFound();

    const items = await tx
      .select()
      .from(prescriptionItems)
      .where(eq(prescriptionItems.prescriptionId, id))
      .orderBy(asc(prescriptionItems.sortOrder));

    return ok<PrescriptionView>({
      id: row.rx.id,
      status: row.rx.status,
      version: row.rx.version,
      rxNo: row.rx.rxNo,
      amendmentReason: row.rx.amendmentReason,
      parentPrescriptionId: row.rx.parentPrescriptionId,
      finalizedAt: row.rx.finalizedAt,
      patient: row.patient,
      visit: {
        id: row.visit.id,
        visitType: row.visit.visitType,
        chiefComplaint: row.visit.chiefComplaint,
        diagnosis: row.visit.diagnosis ?? [],
        advice: row.visit.advice,
        followUpDate: row.visit.followUpDate,
      },
      items: items.map((i) => ({
        drugName: i.drugName,
        strength: i.strength,
        form: i.form,
        route: i.route,
        dose: i.dose,
        timing: i.timing,
        foodRelation: i.foodRelation,
        durationDays: i.durationDays,
        remarks: i.remarks,
      })),
    });
  });
}

function itemValues(ctx: ServiceContext, prescriptionId: string, items: DraftItemInput[]) {
  return items.map((item, index) => ({
    tenantId: ctx.tenantId,
    prescriptionId,
    sortOrder: index,
    drugName: item.drugName,
    strength: item.strength ?? null,
    form: item.form ?? null,
    route: item.route ?? null,
    dose: item.dose ?? null,
    timing: item.timing ?? null,
    foodRelation: item.foodRelation ?? null,
    durationDays: item.durationDays ?? null,
    remarks: item.remarks ?? null,
  }));
}

export async function saveDraft(
  ctx: ServiceContext,
  id: string,
  raw: unknown,
): Promise<Result<{ savedAt: Date }>> {
  if (!can(ctx.role, "rx.draft")) return fail("forbidden", "Only doctors can edit prescriptions.");
  if (!isUuid(id)) return prescriptionNotFound();
  const parsed = draftInputSchema.safeParse(raw);
  if (!parsed.success) return invalidFrom(parsed.error);
  const input = parsed.data;

  try {
    return await withTenant(ctx.tenantId, async (tx): Promise<Result<{ savedAt: Date }>> => {
      // Lock the prescription first so a concurrent finalize cannot interleave with this save.
      const [rx] = await tx
        .select({ id: prescriptions.id, status: prescriptions.status, visitId: prescriptions.visitId })
        .from(prescriptions)
        .where(eq(prescriptions.id, id))
        .limit(1)
        .for("update");
      if (!rx) return prescriptionNotFound();
      if (rx.status !== "draft") {
        return fail("immutable", "This prescription is finalized. Amend it to make changes.");
      }

      await tx
        .update(visits)
        .set({
          visitType: input.visitType,
          chiefComplaint: input.chiefComplaint ?? null,
          diagnosis: input.diagnosis,
          advice: input.advice ?? null,
          followUpDate: input.followUpDate ?? null,
        })
        .where(eq(visits.id, rx.visitId));
      await tx.delete(prescriptionItems).where(eq(prescriptionItems.prescriptionId, id));
      if (input.items.length > 0) {
        await tx.insert(prescriptionItems).values(itemValues(ctx, id, input.items));
      }
      const [saved] = await tx
        .update(prescriptions)
        .set({ updatedAt: new Date() })
        .where(eq(prescriptions.id, id))
        .returning({ updatedAt: prescriptions.updatedAt });
      return ok({ savedAt: saved.updatedAt });
    });
  } catch (error) {
    // The database refuses changes to finalized records (SQLSTATE 23000); report it as immutable.
    if (pgErrorInfo(error).code === "23000") {
      return fail("immutable", "This prescription is finalized. Amend it to make changes.");
    }
    throw error;
  }
}

export async function listPrescriptionsForPatient(
  ctx: ServiceContext,
  patientId: string,
): Promise<Result<PrescriptionSummary[]>> {
  if (!can(ctx.role, "rx.read")) return fail("forbidden", "You cannot view prescriptions.");
  if (!isUuid(patientId)) return patientNotFound();

  return withTenant(ctx.tenantId, async (tx) => {
    const [patient] = await tx.select({ id: patients.id }).from(patients).where(eq(patients.id, patientId)).limit(1);
    if (!patient) return patientNotFound();

    const rows = await tx
      .select({
        id: prescriptions.id,
        rxNo: prescriptions.rxNo,
        version: prescriptions.version,
        status: prescriptions.status,
        chiefComplaint: visits.chiefComplaint,
        createdAt: prescriptions.createdAt,
        finalizedAt: prescriptions.finalizedAt,
      })
      .from(prescriptions)
      .innerJoin(visits, eq(visits.id, prescriptions.visitId))
      .where(eq(visits.patientId, patientId))
      .orderBy(desc(prescriptions.createdAt), desc(prescriptions.id));
    return ok(rows);
  });
}
