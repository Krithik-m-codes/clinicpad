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
  },
  paediatric: {
    key: "paediatric",
    name: "Paediatric",
    description: "Weight beside the age, with dose and schedule columns for syrups and drops.",
    accent: "#0f766e",
    sections: ["vitals", "chiefComplaint", "complaints", "medicalHistory", "examination", "diagnosis", "medicines", "investigations", "advice", "followUp"],
    vitals: ["weightKg", "heightCm", "temperatureF", "pulse", "respiratoryRate", "spo2", "bp"],
    medicineLayout: "pattern",
    prominentWeight: true,
  },
  derma: {
    key: "derma",
    name: "Dermatology",
    description: "Findings first, with how-to-use instructions for creams and lotions.",
    accent: "#6d28d9",
    sections: ["chiefComplaint", "complaints", "examination", "diagnosis", "medicines", "investigations", "advice", "followUp", "medicalHistory", "drugHistory"],
    vitals: [],
    medicineLayout: "topical",
    prominentWeight: false,
  },
};
