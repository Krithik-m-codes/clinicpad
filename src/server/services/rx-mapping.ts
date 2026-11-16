import { prescriptionItems, visits } from "@/server/db/schema";
import type { Investigation, Vitals } from "@/lib/domain/rx-options";
import type { DraftInput, DraftItemInput } from "@/server/validation/prescription";
import type { ServiceContext } from "./context";

export type ItemRow = typeof prescriptionItems.$inferSelect;
export type VisitRow = typeof visits.$inferSelect;

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

/** Copy of `obj` without `keys`. Row copies use it so columns added later are copied too. */
export function omit<T extends object, K extends keyof T>(obj: T, keys: readonly K[]): Omit<T, K> {
  const drop = new Set<PropertyKey>(keys);
  return Object.fromEntries(Object.entries(obj).filter(([key]) => !drop.has(key))) as Omit<T, K>;
}

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
