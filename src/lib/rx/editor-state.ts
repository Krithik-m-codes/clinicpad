import { formatSchedule, parseSchedule } from "@/lib/domain/rx-format";
import type { DurationUnit } from "@/lib/domain/rx-options";
import type { FavouriteView, MedicineHit } from "@/server/services/catalogue";
import type { ClinicalVisitView, ItemView } from "@/server/services/rx-mapping";

export const VITAL_KEYS = [
  "bpSystolic",
  "bpDiastolic",
  "pulse",
  "temperatureF",
  "spo2",
  "respiratoryRate",
  "weightKg",
  "heightCm",
  "bloodSugarMgDl",
] as const;
export type VitalKey = (typeof VITAL_KEYS)[number];

/** One medicine row as the form holds it: every input is a string; `key` is for React only. */
export type EditorMedicine = {
  key: string;
  drugName: string;
  genericName: string;
  strength: string;
  form: string;
  route: string;
  dose: string;
  doseMorning: string;
  doseAfternoon: string;
  doseEvening: string;
  doseNight: string;
  timing: string;
  foodRelation: string;
  periodicity: string;
  isSos: boolean;
  durationValue: string;
  durationUnit: DurationUnit;
  remarks: string;
};

export type EditorInvestigation = { key: string; name: string; instructions: string };

export type EditorState = {
  visitType: "new" | "follow-up";
  chiefComplaint: string;
  complaints: string[];
  diagnosis: string[];
  medicalHistory: string[];
  drugHistory: string[];
  examinationNotes: string;
  vitals: Record<VitalKey, string>;
  vitalsNotes: string;
  investigations: EditorInvestigation[];
  medicines: EditorMedicine[];
  advice: string;
  followUpDate: string;
  followUpReason: string;
};

export type ItemPayload = {
  drugName: string;
  genericName: string;
  strength: string;
  form: string;
  route: string;
  dose: string;
  doseMorning: number | string | null;
  doseAfternoon: number | string | null;
  doseEvening: number | string | null;
  doseNight: number | string | null;
  timing: string;
  foodRelation: string;
  periodicity: string;
  isSos: boolean;
  durationValue: number | string | null;
  durationUnit: DurationUnit;
  remarks: string;
};

export type DraftPayload = {
  visitType: "new" | "follow-up";
  chiefComplaint: string;
  complaints: string[];
  diagnosis: string[];
  medicalHistory: string[];
  drugHistory: string[];
  examinationNotes: string;
  vitals: Record<string, number | string>;
  investigations: { name: string; instructions: string }[];
  items: ItemPayload[];
  advice: string;
  followUpDate: string;
  followUpReason: string;
};

/** Anything with the fields of a prescription line: an ItemView or a FavouriteView. */
export type MedicineLike = Omit<FavouriteView, "id">;

let keySeq = 0;
/** Keys for rows created in the browser. Rows loaded from the server use "init-..." keys. */
export function newKey(): string {
  keySeq += 1;
  return `new-${keySeq}`;
}

const str = (value: string | number | null | undefined) => (value === null || value === undefined ? "" : String(value));
const unitOf = (value: string | null | undefined): DurationUnit =>
  value === "weeks" || value === "months" ? value : "days";

export function emptyMedicine(): EditorMedicine {
  return {
    key: newKey(),
    drugName: "",
    genericName: "",
    strength: "",
    form: "",
    route: "",
    dose: "",
    doseMorning: "",
    doseAfternoon: "",
    doseEvening: "",
    doseNight: "",
    timing: "",
    foodRelation: "",
    periodicity: "",
    isSos: false,
    durationValue: "",
    durationUnit: "days",
    remarks: "",
  };
}

export function medicineFrom(source: MedicineLike, key: string = newKey()): EditorMedicine {
  return {
    key,
    drugName: source.drugName,
    genericName: str(source.genericName),
    strength: str(source.strength),
    form: str(source.form),
    route: str(source.route),
    dose: str(source.dose),
    doseMorning: str(source.doseMorning),
    doseAfternoon: str(source.doseAfternoon),
    doseEvening: str(source.doseEvening),
    doseNight: str(source.doseNight),
    timing: str(source.timing),
    foodRelation: str(source.foodRelation),
    periodicity: str(source.periodicity),
    isSos: source.isSos,
    durationValue: str(source.durationValue),
    durationUnit: unitOf(source.durationUnit),
    remarks: str(source.remarks),
  };
}

/** Picking a catalogue hit fills the name; a favourite also fills its saved dosing. */
export function applyHit(current: EditorMedicine, hit: MedicineHit): EditorMedicine {
  if (hit.favourite) return medicineFrom(hit.favourite, current.key);
  return { ...current, drugName: hit.name, genericName: hit.genericName ?? current.genericName };
}

export function applySchedulePreset(m: EditorMedicine, pattern: string): EditorMedicine {
  const s = parseSchedule(pattern);
  if (!s) return m;
  return {
    ...m,
    doseMorning: str(s.morning),
    doseAfternoon: str(s.afternoon),
    doseEvening: str(s.evening),
    doseNight: str(s.night),
  };
}

function slot(value: string): number | null {
  if (value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function scheduleLabel(m: EditorMedicine): string {
  return formatSchedule({
    morning: slot(m.doseMorning),
    afternoon: slot(m.doseAfternoon),
    evening: slot(m.doseEvening),
    night: slot(m.doseNight),
  });
}

export function isBlankMedicine(m: EditorMedicine): boolean {
  if (m.isSos) return false;
  return [
    m.drugName,
    m.genericName,
    m.strength,
    m.form,
    m.route,
    m.dose,
    m.doseMorning,
    m.doseAfternoon,
    m.doseEvening,
    m.doseNight,
    m.timing,
    m.foodRelation,
    m.periodicity,
    m.durationValue,
    m.remarks,
  ].every((v) => v.trim() === "");
}

/** "" is null; a finite number is a number; anything else is sent as typed so the server reports it. */
export function numberOrRaw(value: string): number | string | null {
  const t = value.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : t;
}

export function editorStateFromView(view: { visit: ClinicalVisitView; items: ItemView[] }): EditorState {
  const v = view.visit;
  const vitals = Object.fromEntries(VITAL_KEYS.map((k) => [k, str(v.vitals[k])])) as Record<VitalKey, string>;
  return {
    visitType: v.visitType === "follow-up" ? "follow-up" : "new",
    chiefComplaint: v.chiefComplaint ?? "",
    complaints: v.complaints,
    diagnosis: v.diagnosis,
    medicalHistory: v.medicalHistory,
    drugHistory: v.drugHistory,
    examinationNotes: v.examinationNotes ?? "",
    vitals,
    vitalsNotes: v.vitals.notes ?? "",
    investigations: v.investigations.map((t, i) => ({ key: `init-t${i}`, name: t.name, instructions: t.instructions ?? "" })),
    medicines: view.items.length > 0 ? view.items.map((item, i) => medicineFrom(item, `init-m${i}`)) : [emptyMedicine()],
    advice: v.advice ?? "",
    followUpDate: v.followUpDate ?? "",
    followUpReason: v.followUpReason ?? "",
  };
}

export function toItemPayload(m: EditorMedicine): ItemPayload {
  return {
    drugName: m.drugName,
    genericName: m.genericName,
    strength: m.strength,
    form: m.form,
    route: m.route,
    dose: m.dose,
    doseMorning: numberOrRaw(m.doseMorning),
    doseAfternoon: numberOrRaw(m.doseAfternoon),
    doseEvening: numberOrRaw(m.doseEvening),
    doseNight: numberOrRaw(m.doseNight),
    timing: m.timing,
    foodRelation: m.foodRelation,
    periodicity: m.periodicity,
    isSos: m.isSos,
    durationValue: numberOrRaw(m.durationValue),
    durationUnit: m.durationUnit,
    remarks: m.remarks,
  };
}

/** The full snapshot sent on every save. Completely blank rows are not sent. */
export function toDraftPayload(s: EditorState): DraftPayload {
  const vitals: Record<string, number | string> = {};
  for (const key of VITAL_KEYS) {
    const value = numberOrRaw(s.vitals[key]);
    if (value !== null) vitals[key] = value;
  }
  if (s.vitalsNotes.trim() !== "") vitals.notes = s.vitalsNotes;
  return {
    visitType: s.visitType,
    chiefComplaint: s.chiefComplaint,
    complaints: s.complaints,
    diagnosis: s.diagnosis,
    medicalHistory: s.medicalHistory,
    drugHistory: s.drugHistory,
    examinationNotes: s.examinationNotes,
    vitals,
    investigations: s.investigations
      .filter((t) => t.name.trim() !== "" || t.instructions.trim() !== "")
      .map((t) => ({ name: t.name, instructions: t.instructions })),
    items: s.medicines.filter((m) => !isBlankMedicine(m)).map(toItemPayload),
    advice: s.advice,
    followUpDate: s.followUpDate,
    followUpReason: s.followUpReason,
  };
}
