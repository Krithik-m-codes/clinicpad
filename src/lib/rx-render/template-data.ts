import { present, rxNoText } from "./common";
import type { FlagFieldKey, MedicineItemKey, TestItemKey, TextFieldKey } from "./fields";
import { formatCalendarDate, formatIssuedDate, hasSlots, quantityText, scheduleText } from "./format";
import { ageText, durationText, foodText, genderText, labelText, periodicityText, pickLabel } from "./labels";
import { TEMPLATE_DEFINITIONS, type VitalKey } from "./templates";
import type { LabelLanguage, RxDocument } from "./types";
import { VITAL_LABEL, vitalText } from "./vitals";

export type TemplateData = {
  text: Record<TextFieldKey, string>;
  flags: Record<FlagFieldKey, boolean>;
  lists: { medicines: Record<MedicineItemKey, string>[]; tests: Record<TestItemKey, string>[] };
};

/* NEEDS NATIVE-SPEAKER REVIEW: visit type words. Codes come from src/server/validation/prescription.ts. */
const VISIT_TYPE: Record<string, { en: string; hi: string }> = {
  new: { en: "New visit", hi: "नई मुलाकात" },
  "follow-up": { en: "Follow-up", hi: "पुनः जांच" },
};

const s = (value: string | null | undefined): string => (present(value) ? value.trim() : "");
const list = (values: readonly string[]): string => values.filter(present).map((v) => v.trim()).join(", ");

/**
 * Every catalogue value as plain text (never markup: the renderer escapes), built from the same snapshot, labels and
 * formatting helpers as the built-in pads, so a custom pad prints exactly the same words. Missing values are "".
 * A draft has no Rx number and no signature (ADR-0032).
 */
export function toTemplateData(doc: RxDocument, lang: LabelLanguage): TemplateData {
  const { patient, clinic, doctor } = doc.snapshot;
  const v = doc.visit;
  const vital = (key: VitalKey) => vitalText(key, v.vitals) ?? "";
  const age = ageText(patient.ageLabel, lang);
  const gender = genderText(patient.gender, lang);
  const followDate = formatCalendarDate(v.followUpDate);
  const reason = s(v.followUpReason);
  const vitalsLine = TEMPLATE_DEFINITIONS.general.vitals
    .map((key) => {
      const value = vitalText(key, v.vitals);
      return value === null ? null : `${labelText(VITAL_LABEL[key], lang)} ${value}`;
    })
    .filter((part): part is string => part !== null)
    .join(" · ");
  const visitType = Object.hasOwn(VISIT_TYPE, v.visitType) ? pickLabel(VISIT_TYPE[v.visitType].en, VISIT_TYPE[v.visitType].hi, lang) : "";

  const text: Record<TextFieldKey, string> = {
    "clinic.name": s(clinic.name),
    "clinic.address": clinic.addressLines.filter(present).map((l) => l.trim()).join("\n"),
    "clinic.phone": s(clinic.phone),
    "clinic.email": s(clinic.email),
    "clinic.footer": clinic.footerLines.filter(present).map((l) => l.trim()).join("\n"),
    "doctor.name": s(doctor.name),
    "doctor.qualifications": s(doctor.qualifications),
    "doctor.designation": s(doctor.designation),
    "doctor.reg_no": s(doctor.registrationNo),
    "doctor.council": s(doctor.registrationCouncil),
    "patient.name": s(patient.name),
    "patient.age": age,
    "patient.gender": gender,
    "patient.age_gender": [age, gender].filter((x) => x !== "").join(" / "),
    "patient.no": patient.patientNo !== null ? String(patient.patientNo) : "",
    "patient.allergies": list(patient.allergies),
    "patient.weight": vital("weightKg"),
    "visit.date": formatIssuedDate(doc.issuedAt ?? doc.snapshot.takenAt, clinic.timezone),
    "visit.rx_no": rxNoText(doc),
    "visit.type": visitType,
    "vitals.bp": vital("bp"),
    "vitals.pulse": vital("pulse"),
    "vitals.temperature": vital("temperatureF"),
    "vitals.spo2": vital("spo2"),
    "vitals.rr": vital("respiratoryRate"),
    "vitals.weight": vital("weightKg"),
    "vitals.height": vital("heightCm"),
    "vitals.bmi": vital("bmi"),
    "vitals.sugar": vital("bloodSugarMgDl"),
    "vitals.line": vitalsLine,
    chief_complaint: s(v.chiefComplaint),
    complaints: list(v.complaints),
    diagnosis: list(v.diagnosis),
    "history.medical": list(v.medicalHistory),
    "history.drug": list(v.drugHistory),
    examination: s(v.examinationNotes),
    advice: s(v.advice),
    "follow_up.date": followDate,
    "follow_up.reason": reason,
    "follow_up.line": [followDate, reason].filter((x) => x !== "").join(" · "),
  };

  const medicines = doc.items.map((item, i): Record<MedicineItemKey, string> => ({
    n: String(i + 1),
    name: s(item.drugName),
    generic: s(item.genericName),
    strength: s(item.strength),
    form: s(item.form),
    route: s(item.route),
    dose: s(item.dose),
    schedule: hasSlots(item) ? scheduleText({ ...item, timing: null }) : "",
    morning: quantityText(item.doseMorning),
    afternoon: quantityText(item.doseAfternoon),
    evening: quantityText(item.doseEvening),
    night: quantityText(item.doseNight),
    timing: s(item.timing),
    food: foodText(item.foodRelation, lang),
    frequency: periodicityText(item.periodicity, lang),
    duration: durationText(item.durationValue, item.durationUnit, lang),
    remarks: s(item.remarks),
    sos: item.isSos ? "SOS" : "",
  }));
  const tests = v.investigations
    .filter((test) => present(test.name))
    .map((test, i): Record<TestItemKey, string> => ({ n: String(i + 1), name: s(test.name), instructions: s(test.instructions) }));

  const flags: Record<FlagFieldKey, boolean> = {
    "has.allergies": patient.allergies.some(present),
    "has.vitals": vitalsLine !== "",
    "has.medicines": medicines.length > 0,
    "has.tests": tests.length > 0,
    "has.follow_up": text["follow_up.line"] !== "",
    "has.signature": doc.status !== "draft" && doctor.signatureAssetId !== null,
  };
  return { text, flags, lists: { medicines, tests } };
}
