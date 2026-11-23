import { present } from "./common";
import type { BoxFieldKey } from "./fields";
import { SECTION_KEYS, type OverlayDefinition } from "./overlay-definition";
import type { SectionKey, VitalKey } from "./templates";
import type { RxDocument } from "./types";
import { vitalText } from "./vitals";

/**
 * The boxes that print the same content as a flow section (a pad may print history in a box instead of the flow).
 * Medicines and investigations have no box: they print only in the flow (publish needs medicines; investigations
 * are therefore omitted whenever the designer unticks them).
 */
export const SECTION_BOX_FIELDS: Record<SectionKey, readonly BoxFieldKey[]> = {
  vitals: ["vitals.bp", "vitals.pulse", "vitals.temperature", "vitals.spo2", "vitals.rr", "vitals.weight", "vitals.height", "vitals.bmi", "vitals.sugar", "vitals.line"],
  chiefComplaint: ["chief_complaint"],
  complaints: ["complaints"],
  medicalHistory: ["history.medical"],
  drugHistory: ["history.drug"],
  examination: ["examination"],
  diagnosis: ["diagnosis"],
  medicines: [],
  investigations: [],
  advice: ["advice"],
  followUp: ["follow_up.date", "follow_up.reason", "follow_up.line"],
};

export const SECTION_NAMES: Record<SectionKey, string> = {
  vitals: "Vitals",
  chiefComplaint: "Chief complaint",
  complaints: "Complaints",
  medicalHistory: "Medical history",
  drugHistory: "Drug history",
  examination: "Examination",
  diagnosis: "Diagnosis",
  medicines: "Medicines",
  investigations: "Investigations",
  advice: "Advice",
  followUp: "Follow-up",
};

/** Sections the pad does not print: not in the flow and not covered by an equivalent box. In catalogue order. */
export function omittedSections(def: OverlayDefinition): SectionKey[] {
  const boxes = new Set<string>(def.boxes.map((b) => b.field));
  return SECTION_KEYS.filter((key) => !def.flow.sections.includes(key) && !SECTION_BOX_FIELDS[key].some((f) => boxes.has(f)));
}

export const sectionNames = (keys: readonly string[]): string => keys.map((k) => (k in SECTION_NAMES ? SECTION_NAMES[k as SectionKey] : k)).join(", ");

const ALL_VITALS: readonly VitalKey[] = ["bp", "pulse", "temperatureF", "spo2", "respiratoryRate", "weightKg", "heightCm", "bmi", "bloodSugarMgDl"];

/** Sections in which the document has something to print (the same emptiness rules as the section renderers). */
export function sectionsWithContent(doc: RxDocument): SectionKey[] {
  const v = doc.visit;
  const notes = typeof v.vitals.notes === "string" && v.vitals.notes.trim() !== "";
  const has: Record<SectionKey, boolean> = {
    vitals: notes || ALL_VITALS.some((k) => vitalText(k, v.vitals) !== null),
    chiefComplaint: present(v.chiefComplaint),
    complaints: v.complaints.some(present),
    medicalHistory: v.medicalHistory.some(present),
    drugHistory: v.drugHistory.some(present),
    examination: present(v.examinationNotes),
    diagnosis: v.diagnosis.some(present),
    medicines: doc.items.length > 0,
    investigations: v.investigations.some((t) => present(t.name)),
    advice: present(v.advice),
    followUp: present(v.followUpReason) || (typeof v.followUpDate === "string" && v.followUpDate.trim() !== ""),
  };
  return SECTION_KEYS.filter((key) => has[key]);
}

/** Content the pinned pad leaves off the paper: sections with content that the definition omits. */
export function unprintedContent(doc: RxDocument, def: OverlayDefinition): SectionKey[] {
  const omitted = new Set<SectionKey>(omittedSections(def));
  return sectionsWithContent(doc).filter((key) => omitted.has(key));
}
