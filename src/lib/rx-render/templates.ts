import type { BuiltinTemplateKey } from "./types";

export type VitalKey = "bp" | "pulse" | "temperatureF" | "spo2" | "respiratoryRate" | "weightKg" | "heightCm" | "bmi" | "bloodSugarMgDl";

export type SectionKey =
  | "vitals"
  | "chiefComplaint"
  | "complaints"
  | "medicalHistory"
  | "drugHistory"
  | "examination"
  | "diagnosis"
  | "medicines"
  | "investigations"
  | "advice"
  | "followUp";

/** slots: M/A/E/N columns (legacy pad); pattern: dose + "1-0-1" columns; topical: how-to-use column. */
export type MedicineLayout = "slots" | "pattern" | "topical";

export type TemplateDefinition = {
  key: BuiltinTemplateKey;
  name: string;
  description: string;
  /** A fixed colour from this file. Never user data: it goes into the document CSS. */
  accent: string;
  sections: SectionKey[];
  vitals: VitalKey[];
  medicineLayout: MedicineLayout;
  /** Paediatric dosing is weight-based: print weight next to the age. */
  prominentWeight: boolean;
  /** Print the vitals as one small line instead of a block (pads where vitals are not the focus). */
  compactVitals: boolean;
};

/** Built-in pads are data, drawn by one renderer. Template Studio (Phase 2) adds other kinds beside them. */
export const TEMPLATE_DEFINITIONS: Record<BuiltinTemplateKey, TemplateDefinition> = {
  general: {
    key: "general",
    name: "General",
    description: "The classic pad: morning, noon, evening and night dose columns.",
    accent: "#b91c1c",
    sections: ["vitals", "chiefComplaint", "complaints", "medicalHistory", "drugHistory", "examination", "diagnosis", "medicines", "investigations", "advice", "followUp"],
    vitals: ["bp", "pulse", "temperatureF", "spo2", "respiratoryRate", "weightKg", "heightCm", "bmi", "bloodSugarMgDl"],
    medicineLayout: "slots",
    prominentWeight: false,
    compactVitals: false,
  },
  paediatric: {
    key: "paediatric",
    name: "Paediatric",
    description: "Weight beside the age, with dose and schedule columns for syrups and drops.",
    accent: "#0f766e",
    sections: ["vitals", "chiefComplaint", "complaints", "medicalHistory", "drugHistory", "examination", "diagnosis", "medicines", "investigations", "advice", "followUp"],
    vitals: ["weightKg", "heightCm", "temperatureF", "pulse", "respiratoryRate", "spo2", "bp", "bloodSugarMgDl"],
    medicineLayout: "pattern",
    prominentWeight: true,
    compactVitals: false,
  },
  derma: {
    key: "derma",
    name: "Dermatology",
    description: "Findings first, a compact vitals line, and how-to-use instructions for creams and lotions.",
    accent: "#6d28d9",
    sections: ["chiefComplaint", "complaints", "examination", "vitals", "diagnosis", "medicines", "investigations", "advice", "followUp", "medicalHistory", "drugHistory"],
    vitals: ["bp", "pulse", "temperatureF", "spo2", "respiratoryRate", "weightKg", "heightCm", "bmi", "bloodSugarMgDl"],
    medicineLayout: "topical",
    prominentWeight: false,
    compactVitals: true,
  },
  // Plan 2C gallery (ADR-0053). The clinical form is fixed, so a specialty pad differs by emphasis: what comes first, which
  // vitals lead, how medicines are laid out, and the accent. Every pad prints every section and every vital (nothing
  // recorded is dropped: tests/unit/rx-render.test.ts "completeness").
  ortho: {
    key: "ortho",
    name: "Orthopaedic",
    description: "Complaint, examination and investigations (X-ray, MRI) up front; dose columns for painkillers and supplements.",
    accent: "#9a3412",
    sections: ["chiefComplaint", "complaints", "examination", "diagnosis", "investigations", "medicines", "advice", "followUp", "vitals", "medicalHistory", "drugHistory"],
    vitals: ["weightKg", "heightCm", "bmi", "bp", "pulse", "temperatureF", "spo2", "respiratoryRate", "bloodSugarMgDl"],
    medicineLayout: "slots",
    prominentWeight: false,
    compactVitals: true,
  },
  ent: {
    key: "ent",
    name: "ENT",
    description: "Findings first, a compact vitals line, and how-to-use instructions for ear and nasal drops and sprays.",
    accent: "#0369a1",
    sections: ["chiefComplaint", "complaints", "examination", "diagnosis", "medicines", "investigations", "advice", "followUp", "vitals", "medicalHistory", "drugHistory"],
    vitals: ["temperatureF", "pulse", "spo2", "bp", "respiratoryRate", "weightKg", "heightCm", "bmi", "bloodSugarMgDl"],
    medicineLayout: "topical",
    prominentWeight: false,
    compactVitals: true,
  },
  gynae: {
    key: "gynae",
    name: "Gynaecology and obstetrics",
    description: "Blood pressure and weight lead the vitals, history before examination, investigations before medicines.",
    accent: "#be185d",
    sections: ["vitals", "chiefComplaint", "complaints", "medicalHistory", "drugHistory", "examination", "diagnosis", "investigations", "medicines", "advice", "followUp"],
    vitals: ["bp", "weightKg", "pulse", "heightCm", "bmi", "bloodSugarMgDl", "temperatureF", "spo2", "respiratoryRate"],
    medicineLayout: "slots",
    prominentWeight: false,
    compactVitals: false,
  },
  dental: {
    key: "dental",
    name: "Dental",
    description: "Complaint, medical and drug history (allergies, blood thinners), then findings, medicines and aftercare advice.",
    accent: "#0e7490",
    sections: ["chiefComplaint", "complaints", "medicalHistory", "drugHistory", "examination", "diagnosis", "medicines", "advice", "investigations", "followUp", "vitals"],
    vitals: ["bp", "pulse", "bloodSugarMgDl", "temperatureF", "spo2", "respiratoryRate", "weightKg", "heightCm", "bmi"],
    medicineLayout: "slots",
    prominentWeight: false,
    compactVitals: true,
  },
  physio: {
    key: "physio",
    name: "Physiotherapy",
    description: "Complaint and examination first, advice (exercises, precautions) before medicines, compact vitals.",
    accent: "#15803d",
    sections: ["chiefComplaint", "complaints", "examination", "diagnosis", "advice", "medicines", "investigations", "followUp", "vitals", "medicalHistory", "drugHistory"],
    vitals: ["weightKg", "heightCm", "bmi", "bp", "pulse", "temperatureF", "spo2", "respiratoryRate", "bloodSugarMgDl"],
    medicineLayout: "slots",
    prominentWeight: false,
    compactVitals: true,
  },
  ayush: {
    key: "ayush",
    name: "Ayurveda and homeopathy",
    description: "Complaints and history in detail, then medicines with dose and schedule columns (pills, drops, powders).",
    accent: "#a16207",
    sections: ["chiefComplaint", "complaints", "medicalHistory", "drugHistory", "vitals", "examination", "diagnosis", "medicines", "advice", "investigations", "followUp"],
    vitals: ["pulse", "bp", "weightKg", "temperatureF", "heightCm", "bmi", "spo2", "respiratoryRate", "bloodSugarMgDl"],
    medicineLayout: "pattern",
    prominentWeight: false,
    compactVitals: true,
  },
};
