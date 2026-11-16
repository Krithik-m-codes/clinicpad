import { and, asc, count, desc, eq, isNull } from "drizzle-orm";
import { fail, invalidFrom, ok, type Result, type ServiceError } from "@/lib/result";
import { can } from "@/lib/domain/permissions";
import { isUuid } from "@/lib/domain/ids";
import { doctors, patients, prescriptionItems, prescriptions, visits } from "@/server/db/schema";
import { pgErrorInfo } from "@/server/db/errors";
import { withTenant, type TenantTx } from "@/server/db/tenant";
import { amendReasonSchema, draftInputSchema, type DraftItemInput } from "@/server/validation/prescription";
import type { ServiceContext } from "./context";
import { allocateNumber } from "./numbering";
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
  patient: { id: string; name: string; patientNo: number | null; allergies: string[] };
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

const BAD_TEXT_MESSAGE = "Some text contains a character that cannot be saved.";
const BAD_DATE_MESSAGE = "Enter a real follow-up date.";

/**
 * Defence in depth behind the validation layer: Postgres refusing a value (SQLSTATE 22021 invalid byte
 * sequence, 22007/22008 bad or out-of-range date) is bad input, not a server fault. Returns null for
 * any other error so the caller keeps its own handling.
 */
function invalidFromDatabase(error: unknown, fields: { text?: string; date?: string }): ServiceError | null {
  const { code } = pgErrorInfo(error);
  if (code === "22021") return fail("invalid", BAD_TEXT_MESSAGE, fields.text);
  if (code === "22007" || code === "22008") return fail("invalid", BAD_DATE_MESSAGE, fields.date);
  return null;
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
        patient: { id: patients.id, name: patients.name, patientNo: patients.patientNo, allergies: patients.allergies },
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
      patient: { ...row.patient, allergies: row.patient.allergies ?? [] },
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
    // The transaction has rolled back, so nothing was written.
    const invalid = invalidFromDatabase(error, { date: "followUpDate" });
    if (invalid) return invalid;
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

const IMMUTABLE_MESSAGE = "This prescription is finalized and cannot be changed.";
const AMENDMENT_IN_PROGRESS = "An amendment is already in progress.";
const OPEN_AMENDMENT_INDEX = "prescriptions_one_open_amendment";

export async function finalizePrescription(
  ctx: ServiceContext,
  id: string,
): Promise<Result<{ rxNo: number; version: number }>> {
  if (!can(ctx.role, "rx.finalize")) return fail("forbidden", "Only doctors can finalize prescriptions.");
  if (!isUuid(id)) return prescriptionNotFound();

  try {
    return await withTenant(ctx.tenantId, async (tx): Promise<Result<{ rxNo: number; version: number }>> => {
      // The row lock comes first: it serializes double-clicks (the second request waits, then sees
      // "finalized") and it must precede any visit or item write to keep one lock order everywhere.
      const [rx] = await tx.select().from(prescriptions).where(eq(prescriptions.id, id)).limit(1).for("update");
      if (!rx) return prescriptionNotFound();
      if (rx.status !== "draft") return fail("conflict", "This prescription is already finalized.");

      const [{ value: itemCount }] = await tx
        .select({ value: count() })
        .from(prescriptionItems)
        .where(eq(prescriptionItems.prescriptionId, id));
      if (itemCount === 0) return fail("invalid", "Add at least one medicine before finalizing.", "items");

      // First versions (no parent) get the next number; amendments must already carry their parent's.
      // An amendment without a number means a corrupt chain: refuse rather than allocate a second number
      // for the same prescription. Allocating only after every check passes, inside this transaction,
      // means a failed finalize never burns a number.
      let rxNo: number;
      if (rx.parentPrescriptionId === null) {
        rxNo = await allocateNumber(tx, ctx.tenantId, "rx");
      } else if (rx.rxNo === null) {
        return fail("conflict", "The original prescription has no Rx number, so this amendment cannot be finalized.");
      } else {
        rxNo = rx.rxNo;
      }
      const now = new Date();

      await tx
        .update(prescriptions)
        .set({ status: "finalized", rxNo, finalizedAt: now, finalizedBy: ctx.userId })
        .where(eq(prescriptions.id, id));
      // Only status and finalized_at may change on a visit whose prescription is already finalized.
      await tx.update(visits).set({ status: "finalized", finalizedAt: now }).where(eq(visits.id, rx.visitId));
      if (rx.parentPrescriptionId) {
        // The parent flip may change nothing but status.
        await tx
          .update(prescriptions)
          .set({ status: "amended" })
          .where(eq(prescriptions.id, rx.parentPrescriptionId));
      }
      await recordAudit(tx, ctx, {
        action: rx.parentPrescriptionId ? "prescription.amended" : "prescription.finalized",
        entityType: "prescription",
        entityId: id,
        after: rx.parentPrescriptionId
          ? { rxNo, version: rx.version, parentPrescriptionId: rx.parentPrescriptionId }
          : { rxNo, version: rx.version },
      });
      return ok({ rxNo, version: rx.version });
    });
  } catch (error) {
    if (pgErrorInfo(error).code === "23000") return fail("immutable", IMMUTABLE_MESSAGE);
    throw error;
  }
}

export async function amendPrescription(
  ctx: ServiceContext,
  input: { prescriptionId: string; reason: string },
): Promise<Result<{ prescriptionId: string; version: number }>> {
  if (!can(ctx.role, "rx.amend")) return fail("forbidden", "Only doctors can amend prescriptions.");
  if (!isUuid(input.prescriptionId)) return prescriptionNotFound();
  const reason = amendReasonSchema.safeParse(input.reason);
  if (!reason.success) return fail("invalid", reason.error.issues[0].message, "reason");

  try {
    return await withTenant(ctx.tenantId, async (tx): Promise<Result<{ prescriptionId: string; version: number }>> => {
      const [source] = await tx
        .select()
        .from(prescriptions)
        .where(eq(prescriptions.id, input.prescriptionId))
        .limit(1)
        .for("update");
      if (!source) return prescriptionNotFound();
      if (source.status === "draft") return fail("conflict", "A draft cannot be amended; edit it directly.");
      if (source.status !== "finalized") {
        return fail("conflict", "A newer version of this prescription already exists.");
      }

      const [open] = await tx
        .select({ id: prescriptions.id })
        .from(prescriptions)
        .where(and(eq(prescriptions.parentPrescriptionId, source.id), eq(prescriptions.status, "draft")))
        .limit(1);
      if (open) return fail("conflict", AMENDMENT_IN_PROGRESS);

      const [oldVisit] = await tx.select().from(visits).where(eq(visits.id, source.visitId)).limit(1);
      const [newVisit] = await tx
        .insert(visits)
        .values({
          tenantId: ctx.tenantId,
          patientId: oldVisit.patientId,
          doctorId: oldVisit.doctorId,
          branchId: oldVisit.branchId,
          status: "draft",
          visitType: oldVisit.visitType,
          chiefComplaint: oldVisit.chiefComplaint,
          vitals: oldVisit.vitals,
          diagnosis: oldVisit.diagnosis,
          advice: oldVisit.advice,
          followUpDate: oldVisit.followUpDate,
        })
        .returning({ id: visits.id });
      const [rx] = await tx
        .insert(prescriptions)
        .values({
          tenantId: ctx.tenantId,
          visitId: newVisit.id,
          rxNo: source.rxNo,
          version: source.version + 1,
          status: "draft",
          parentPrescriptionId: source.id,
          amendmentReason: reason.data,
          templateVersionId: source.templateVersionId,
        })
        .returning({ id: prescriptions.id, version: prescriptions.version });
      await copyItems(tx, ctx, source.id, rx.id);
      // The reason is free text and lives on the prescription row; the audit log keeps only its length.
      await recordAudit(tx, ctx, {
        action: "prescription.amendment_drafted",
        entityType: "prescription",
        entityId: rx.id,
        before: { version: source.version },
        after: { version: rx.version, parentPrescriptionId: source.id, reasonLength: reason.data.length },
      });
      return ok({ prescriptionId: rx.id, version: rx.version });
    });
  } catch (error) {
    // The partial unique index is the backstop for a race the row lock did not catch. Any other
    // unique violation is a different bug and must surface, not be reported as "in progress".
    const info = pgErrorInfo(error);
    if (info.code === "23505" && info.constraint === OPEN_AMENDMENT_INDEX) {
      return fail("conflict", AMENDMENT_IN_PROGRESS);
    }
    // Only the reason is new free text here (the rest is copied from rows that already passed the database).
    const invalid = invalidFromDatabase(error, { text: "reason" });
    if (invalid) return invalid;
    throw error;
  }
}

export async function repeatPrescription(
  ctx: ServiceContext,
  id: string,
): Promise<Result<{ prescriptionId: string }>> {
  if (!can(ctx.role, "rx.draft")) return fail("forbidden", "Only doctors can write prescriptions.");
  if (!isUuid(id)) return prescriptionNotFound();

  return withTenant(ctx.tenantId, async (tx): Promise<Result<{ prescriptionId: string }>> => {
    const [source] = await tx.select().from(prescriptions).where(eq(prescriptions.id, id)).limit(1);
    if (!source) return prescriptionNotFound();
    if (source.status === "draft") return fail("conflict", "Finalize this draft before repeating it.");
    // A superseded version holds exactly the content an amendment corrected; never copy it forward.
    if (source.status !== "finalized") {
      return fail("conflict", "This prescription was superseded by a later version; repeat the latest version.");
    }

    const [oldVisit] = await tx.select().from(visits).where(eq(visits.id, source.visitId)).limit(1);
    const [patient] = await tx
      .select({ id: patients.id })
      .from(patients)
      .where(and(eq(patients.id, oldVisit.patientId), isNull(patients.deletedAt)))
      .limit(1);
    if (!patient) return patientNotFound();

    const [newVisit] = await tx
      .insert(visits)
      .values({
        tenantId: ctx.tenantId,
        patientId: patient.id,
        doctorId: await doctorIdFor(tx, ctx.userId),
        branchId: oldVisit.branchId,
        status: "draft",
        visitType: "follow-up",
        chiefComplaint: oldVisit.chiefComplaint,
        diagnosis: oldVisit.diagnosis,
        advice: oldVisit.advice,
      })
      .returning({ id: visits.id });
    const [rx] = await tx
      .insert(prescriptions)
      .values({ tenantId: ctx.tenantId, visitId: newVisit.id, status: "draft", version: 1 })
      .returning({ id: prescriptions.id });
    await copyItems(tx, ctx, source.id, rx.id);
    await recordAudit(tx, ctx, {
      action: "prescription.drafted",
      entityType: "prescription",
      entityId: rx.id,
      after: { version: 1, repeatedFrom: source.id },
    });
    return ok({ prescriptionId: rx.id });
  });
}
