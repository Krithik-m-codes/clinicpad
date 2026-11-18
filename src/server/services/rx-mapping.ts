import { asc, eq } from "drizzle-orm";
import { prescriptionItems, prescriptions, visits } from "@/server/db/schema";
import type { TenantTx } from "@/server/db/tenant";
import type { Investigation, Vitals } from "@/lib/domain/rx-options";
import type { DraftInput, DraftItemInput } from "@/server/validation/prescription";
import type { ServiceContext } from "./context";

export type ItemRow = typeof prescriptionItems.$inferSelect;
export type VisitRow = typeof visits.$inferSelect;
export type PrescriptionRow = typeof prescriptions.$inferSelect;

/**
 * Column classification for every row copy (amend, repeat). A column is either carried over from
 * the source row (`copy`) or starts fresh in the new row (`reset`: a new id, a fresh status, or a value
 * the caller assigns explicitly). `satisfies Record<keyof Row, ...>` makes a column added to the schema
 * a compile error until someone decides which it is, so a new column can neither be silently copied
 * nor silently dropped. `renderSnapshot` is always `reset`: a new draft must never inherit a frozen
 * snapshot (Plan 1C, ADR-0032).
 */
export type ColumnRule = "copy" | "reset";

/** Visit columns of an amendment: the same visit, corrected. */
export const AMEND_VISIT_COLUMNS = {
  id: "reset",
  tenantId: "copy",
  patientId: "copy",
  doctorId: "copy",
  branchId: "copy",
  status: "reset",
  visitType: "copy",
  chiefComplaint: "copy",
  vitals: "copy",
  diagnosis: "copy",
  advice: "copy",
  followUpDate: "copy",
  complaints: "copy",
  medicalHistory: "copy",
  drugHistory: "copy",
  examinationNotes: "copy",
  investigations: "copy",
  followUpReason: "copy",
  finalizedAt: "reset",
  createdAt: "reset",
  updatedAt: "reset",
} as const satisfies Record<keyof VisitRow, ColumnRule>;

/** Visit columns of a repeat: what was prescribed, not what was measured or found on the old day. */
export const REPEAT_VISIT_COLUMNS = {
  id: "reset",
  tenantId: "copy",
  patientId: "copy",
  doctorId: "reset", // the repeating doctor, assigned by the caller
  branchId: "copy",
  status: "reset",
  visitType: "reset", // always "follow-up"
  chiefComplaint: "copy",
  vitals: "reset",
  diagnosis: "copy",
  advice: "copy",
  followUpDate: "reset",
  complaints: "copy",
  medicalHistory: "copy",
  drugHistory: "copy",
  examinationNotes: "reset",
  investigations: "copy",
  followUpReason: "reset",
  finalizedAt: "reset",
  createdAt: "reset",
  updatedAt: "reset",
} as const satisfies Record<keyof VisitRow, ColumnRule>;

/** Item columns of amend and repeat: every medicine field is copied; keys and ownership are assigned fresh. */
export const COPIED_ITEM_COLUMNS = {
  id: "reset",
  tenantId: "reset",
  prescriptionId: "reset",
  sortOrder: "copy",
  drugName: "copy",
  strength: "copy",
  form: "copy",
  route: "copy",
  dose: "copy",
  timing: "copy",
  foodRelation: "copy",
  durationDays: "copy",
  remarks: "copy",
  genericName: "copy",
  doseMorning: "copy",
  doseAfternoon: "copy",
  doseEvening: "copy",
  doseNight: "copy",
  periodicity: "copy",
  isSos: "copy",
  durationValue: "copy",
  durationUnit: "copy",
  createdAt: "reset",
} as const satisfies Record<keyof ItemRow, ColumnRule>;

/** Prescription columns of an amendment. The caller assigns the `reset` ones that need a value (visit, version, parent, reason). */
export const AMEND_PRESCRIPTION_COLUMNS = {
  id: "reset",
  tenantId: "reset",
  visitId: "reset",
  rxNo: "copy", // an amendment keeps its original's number
  version: "reset",
  draftRevision: "reset",
  status: "reset",
  templateVersionId: "copy",
  pdfUrl: "reset",
  parentPrescriptionId: "reset",
  amendmentReason: "reset",
  finalizedBy: "reset",
  renderSnapshot: "reset", // never inherit a frozen snapshot: finalize writes this version's own
  updatedAt: "reset",
  finalizedAt: "reset",
  createdAt: "reset",
} as const satisfies Record<keyof PrescriptionRow, ColumnRule>;

/** Prescription columns of a repeat: a repeat is a brand-new prescription, so nothing is carried over. */
export const REPEAT_PRESCRIPTION_COLUMNS = {
  id: "reset",
  tenantId: "reset",
  visitId: "reset",
  rxNo: "reset",
  version: "reset",
  draftRevision: "reset",
  status: "reset",
  templateVersionId: "reset",
  pdfUrl: "reset",
  parentPrescriptionId: "reset",
  amendmentReason: "reset",
  finalizedBy: "reset",
  renderSnapshot: "reset",
  updatedAt: "reset",
  finalizedAt: "reset",
  createdAt: "reset",
} as const satisfies Record<keyof PrescriptionRow, ColumnRule>;

type CopiedKeys<Row, Rules extends Record<keyof Row, ColumnRule>> = {
  [K in keyof Rules]: Rules[K] extends "copy" ? K : never;
}[keyof Rules] &
  keyof Row;

/** The columns of `row` that the rules mark `copy` (typed, so a required column stays required). */
export function copiedColumns<Row extends object, Rules extends Record<keyof Row, ColumnRule>>(
  row: Row,
  rules: Rules,
): Pick<Row, CopiedKeys<Row, Rules>> {
  const out: Partial<Row> = {};
  for (const key of Object.keys(rules) as (keyof Row)[]) {
    if (rules[key] === "copy") out[key] = row[key];
  }
  return out as Pick<Row, CopiedKeys<Row, Rules>>;
}

export type ItemView = {
  drugName: string;
  genericName: string | null;
  strength: string | null;
  form: string | null;
  route: string | null;
  dose: string | null;
  doseMorning: number | null;
  doseAfternoon: number | null;
  doseEvening: number | null;
  doseNight: number | null;
  timing: string | null;
  foodRelation: string | null;
  periodicity: string | null;
  isSos: boolean;
  durationValue: number | null;
  durationUnit: string | null;
  durationDays: number | null;
  remarks: string | null;
};

export type ClinicalVisitView = {
  id: string;
  visitType: string;
  chiefComplaint: string | null;
  complaints: string[];
  diagnosis: string[];
  medicalHistory: string[];
  drugHistory: string[];
  examinationNotes: string | null;
  vitals: Vitals;
  investigations: Investigation[];
  advice: string | null;
  followUpDate: string | null;
  followUpReason: string | null;
};

export function toItemView(row: ItemRow): ItemView {
  // Rows written before Plan 1B have only duration_days: read them as a number of days.
  const legacy = row.durationValue === null && row.durationDays !== null;
  return {
    drugName: row.drugName,
    genericName: row.genericName,
    strength: row.strength,
    form: row.form,
    route: row.route,
    dose: row.dose,
    doseMorning: row.doseMorning,
    doseAfternoon: row.doseAfternoon,
    doseEvening: row.doseEvening,
    doseNight: row.doseNight,
    timing: row.timing,
    foodRelation: row.foodRelation,
    periodicity: row.periodicity,
    isSos: row.isSos,
    durationValue: legacy ? row.durationDays : row.durationValue,
    durationUnit: legacy ? "days" : row.durationUnit,
    durationDays: row.durationDays,
    remarks: row.remarks,
  };
}

export function toVisitView(row: VisitRow): ClinicalVisitView {
  return {
    id: row.id,
    visitType: row.visitType,
    chiefComplaint: row.chiefComplaint,
    complaints: row.complaints ?? [],
    diagnosis: row.diagnosis ?? [],
    medicalHistory: row.medicalHistory ?? [],
    drugHistory: row.drugHistory ?? [],
    examinationNotes: row.examinationNotes,
    vitals: row.vitals ?? {},
    investigations: row.investigations ?? [],
    advice: row.advice,
    followUpDate: row.followUpDate,
    followUpReason: row.followUpReason,
  };
}

/**
 * The visit columns a draft save writes. The schema always fills the lists and `vitals`; the
 * fallbacks matter only to tests/integration/prescriptions-db-errors.test.ts, which replaces the
 * schema with a pass-through to prove the database-error mapping, and must not turn into a crash.
 */
export function visitColumns(input: DraftInput) {
  const vitals = input.vitals ?? {};
  return {
    visitType: input.visitType ?? "new",
    chiefComplaint: input.chiefComplaint ?? null,
    complaints: input.complaints ?? [],
    diagnosis: input.diagnosis ?? [],
    medicalHistory: input.medicalHistory ?? [],
    drugHistory: input.drugHistory ?? [],
    examinationNotes: input.examinationNotes ?? null,
    vitals: Object.keys(vitals).length > 0 ? vitals : null,
    investigations: input.investigations ?? [],
    advice: input.advice ?? null,
    followUpDate: input.followUpDate ?? null,
    followUpReason: input.followUpReason ?? null,
  };
}

/** Item rows for a draft save, in the order the doctor wrote them. */
export function itemValues(ctx: ServiceContext, prescriptionId: string, items: DraftItemInput[]) {
  return items.map((item, index) => ({
    tenantId: ctx.tenantId,
    prescriptionId,
    sortOrder: index,
    drugName: item.drugName,
    genericName: item.genericName ?? null,
    strength: item.strength ?? null,
    form: item.form ?? null,
    route: item.route ?? null,
    dose: item.dose ?? null,
    doseMorning: item.doseMorning ?? null,
    doseAfternoon: item.doseAfternoon ?? null,
    doseEvening: item.doseEvening ?? null,
    doseNight: item.doseNight ?? null,
    timing: item.timing ?? null,
    foodRelation: item.foodRelation ?? null,
    periodicity: item.periodicity ?? null,
    isSos: item.isSos ?? false,
    durationValue: item.durationValue ?? null,
    durationUnit: item.durationUnit ?? null,
    durationDays: item.durationDays ?? null,
    remarks: item.remarks ?? null,
  }));
}

type VisitInsert = typeof visits.$inferInsert;

/** Copies every item column (amend and repeat). Items are inserted while the target is a draft. */
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
    rows.map((row) => ({
      ...copiedColumns(row, COPIED_ITEM_COLUMNS),
      tenantId: ctx.tenantId,
      prescriptionId: toPrescriptionId,
    })),
  );
}

/** An amendment corrects the same visit, so it carries every column of the original. */
export function amendVisitValues(old: VisitRow): VisitInsert {
  return { ...copiedColumns(old, AMEND_VISIT_COLUMNS), tenantId: old.tenantId, patientId: old.patientId, status: "draft" };
}

/**
 * A repeat is a new visit: it copies what was prescribed, not what was measured or found
 * on the old day (vitals, examination notes, follow-up).
 */
export function repeatVisitValues(old: VisitRow, doctorId: string | null): VisitInsert {
  return {
    ...copiedColumns(old, REPEAT_VISIT_COLUMNS),
    tenantId: old.tenantId,
    patientId: old.patientId,
    doctorId,
    status: "draft",
    visitType: "follow-up",
  };
}

const SUMMARY_FIELDS = [
  "chiefComplaint",
  "complaints",
  "diagnosis",
  "medicalHistory",
  "drugHistory",
  "examinationNotes",
  "vitals",
  "investigations",
  "advice",
  "followUpDate",
  "followUpReason",
] as const;

export type ClinicalSummary = {
  itemCount: number;
  diagnosisCount: number;
  investigationCount: number;
  vitalsRecorded: string[];
  filledFields: string[];
};

/** Audit-safe description of a visit: field names and counts only, never the text itself. */
export function clinicalSummary(visit: VisitRow, itemCount: number): ClinicalSummary {
  const filledFields = SUMMARY_FIELDS.filter((key) => {
    const value: unknown = visit[key];
    if (value === null || value === undefined) return false;
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === "object") return Object.keys(value).length > 0;
    return String(value).trim() !== "";
  });
  return {
    itemCount,
    diagnosisCount: visit.diagnosis?.length ?? 0,
    investigationCount: visit.investigations?.length ?? 0,
    vitalsRecorded: Object.keys(visit.vitals ?? {})
      .filter((key) => key !== "notes")
      .sort(),
    filledFields: [...filledFields],
  };
}
