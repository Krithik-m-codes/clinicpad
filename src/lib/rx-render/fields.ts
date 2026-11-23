/**
 * The field catalogue (spec section 5.5): every value a custom template may print, by name. Templates never see
 * database rows; toTemplateData() fills these from the frozen snapshot, the visit and the items. Names follow
 * PRODUCT_SPEC 7.3 and ADR-0014. Overlay boxes use text and image fields; lists and flags are for DOCX (2B).
 * NEEDS NATIVE-SPEAKER REVIEW: every Hindi label below is a first draft.
 */
export const TEXT_FIELD_KEYS = [
  "clinic.name", "clinic.address", "clinic.phone", "clinic.email", "clinic.footer",
  "doctor.name", "doctor.qualifications", "doctor.designation", "doctor.reg_no", "doctor.council",
  "patient.name", "patient.age", "patient.gender", "patient.age_gender", "patient.no", "patient.allergies", "patient.weight",
  "visit.date", "visit.rx_no", "visit.type",
  "vitals.bp", "vitals.pulse", "vitals.temperature", "vitals.spo2", "vitals.rr", "vitals.weight", "vitals.height", "vitals.bmi", "vitals.sugar", "vitals.line",
  "chief_complaint", "complaints", "diagnosis", "history.medical", "history.drug", "examination", "advice",
  "follow_up.date", "follow_up.reason", "follow_up.line",
] as const;
export const IMAGE_FIELD_KEYS = ["clinic.logo", "doctor.signature"] as const;
export const BOX_FIELD_KEYS = [...TEXT_FIELD_KEYS, ...IMAGE_FIELD_KEYS] as const;
export const LIST_FIELD_KEYS = ["medicines", "tests"] as const;
export const FLAG_FIELD_KEYS = ["has.allergies", "has.vitals", "has.medicines", "has.tests", "has.follow_up", "has.signature"] as const;
export const MEDICINE_ITEM_KEYS = [
  "n", "name", "generic", "strength", "form", "route", "dose", "schedule", "morning", "afternoon", "evening", "night",
  "timing", "food", "frequency", "duration", "remarks", "sos",
] as const;
export const TEST_ITEM_KEYS = ["n", "name", "instructions"] as const;

/** Names people expect that are deliberately not printable: refused with this reason (Q14; QR needs a share link). */
export const RESERVED_FIELD_KEYS = {
  qr: "QR codes on pads are coming later.",
  "patient.phone": "Pads do not print the patient's phone number.",
} as const;

export type TextFieldKey = (typeof TEXT_FIELD_KEYS)[number];
export type ImageFieldKey = (typeof IMAGE_FIELD_KEYS)[number];
export type BoxFieldKey = (typeof BOX_FIELD_KEYS)[number];
export type ListFieldKey = (typeof LIST_FIELD_KEYS)[number];
export type FlagFieldKey = (typeof FLAG_FIELD_KEYS)[number];
export type MedicineItemKey = (typeof MEDICINE_ITEM_KEYS)[number];
export type TestItemKey = (typeof TEST_ITEM_KEYS)[number];
export type FieldKey = BoxFieldKey | ListFieldKey | FlagFieldKey;
export type FieldType = "text" | "image" | "list" | "flag";
export type FieldGroup = "clinic" | "doctor" | "patient" | "visit" | "vitals" | "clinical" | "lists" | "flags";
export type TemplateFieldInfo = { type: FieldType; group: FieldGroup; en: string; hi: string };

const t = (group: FieldGroup, en: string, hi: string): TemplateFieldInfo => ({ type: "text", group, en, hi });

export const TEMPLATE_FIELDS: Record<FieldKey, TemplateFieldInfo> = {
  "clinic.name": t("clinic", "Clinic name", "क्लिनिक का नाम"),
  "clinic.address": t("clinic", "Clinic address", "क्लिनिक का पता"),
  "clinic.phone": t("clinic", "Clinic phone", "क्लिनिक फोन"),
  "clinic.email": t("clinic", "Clinic email", "क्लिनिक ईमेल"),
  "clinic.footer": t("clinic", "Pad footer", "पैड फुटर"),
  "clinic.logo": { type: "image", group: "clinic", en: "Clinic logo", hi: "क्लिनिक लोगो" },
  "doctor.name": t("doctor", "Doctor's name", "चिकित्सक का नाम"),
  "doctor.qualifications": t("doctor", "Qualifications", "योग्यताएं"),
  "doctor.designation": t("doctor", "Designation", "पद"),
  "doctor.reg_no": t("doctor", "Registration no.", "पंजीकरण संख्या"),
  "doctor.council": t("doctor", "Medical council", "चिकित्सा परिषद"),
  "doctor.signature": { type: "image", group: "doctor", en: "Signature (never on drafts)", hi: "हस्ताक्षर" },
  "patient.name": t("patient", "Patient's name", "रोगी का नाम"),
  "patient.age": t("patient", "Age", "आयु"),
  "patient.gender": t("patient", "Gender", "लिंग"),
  "patient.age_gender": t("patient", "Age / gender", "आयु / लिंग"),
  "patient.no": t("patient", "Patient no.", "रोगी क्रमांक"),
  "patient.allergies": t("patient", "Allergies", "एलर्जी"),
  "patient.weight": t("patient", "Weight", "वजन"),
  "visit.date": t("visit", "Date", "दिनांक"),
  "visit.rx_no": t("visit", "Rx no. (blank on drafts)", "पर्चा क्रमांक"),
  "visit.type": t("visit", "Visit type", "मुलाकात का प्रकार"),
  "vitals.bp": t("vitals", "BP", "रक्तचाप"),
  "vitals.pulse": t("vitals", "Pulse", "नाड़ी"),
  "vitals.temperature": t("vitals", "Temperature", "तापमान"),
  "vitals.spo2": t("vitals", "SpO2", "SpO2"),
  "vitals.rr": t("vitals", "Respiratory rate", "श्वसन दर"),
  "vitals.weight": t("vitals", "Weight", "वजन"),
  "vitals.height": t("vitals", "Height", "लंबाई"),
  "vitals.bmi": t("vitals", "BMI", "BMI"),
  "vitals.sugar": t("vitals", "Blood sugar", "शुगर"),
  "vitals.line": t("vitals", "Vitals (one line)", "जीवन संकेत (एक पंक्ति)"),
  chief_complaint: t("clinical", "Chief complaint", "मुख्य शिकायत"),
  complaints: t("clinical", "Complaints", "शिकायतें"),
  diagnosis: t("clinical", "Diagnosis", "निदान"),
  "history.medical": t("clinical", "Medical history", "चिकित्सा इतिहास"),
  "history.drug": t("clinical", "Drug history", "दवा इतिहास"),
  examination: t("clinical", "Examination", "जांच"),
  advice: t("clinical", "Advice", "सलाह"),
  "follow_up.date": t("clinical", "Follow-up date", "पुनः जांच दिनांक"),
  "follow_up.reason": t("clinical", "Follow-up reason", "पुनः जांच का कारण"),
  "follow_up.line": t("clinical", "Follow-up", "पुनः जांच"),
  medicines: { type: "list", group: "lists", en: "Medicines", hi: "दवाइयां" },
  tests: { type: "list", group: "lists", en: "Tests", hi: "जांचें" },
  "has.allergies": { type: "flag", group: "flags", en: "Has allergies", hi: "एलर्जी है" },
  "has.vitals": { type: "flag", group: "flags", en: "Has vitals", hi: "जीवन संकेत हैं" },
  "has.medicines": { type: "flag", group: "flags", en: "Has medicines", hi: "दवाइयां हैं" },
  "has.tests": { type: "flag", group: "flags", en: "Has tests", hi: "जांचें हैं" },
  "has.follow_up": { type: "flag", group: "flags", en: "Has a follow-up", hi: "पुनः जांच है" },
  "has.signature": { type: "flag", group: "flags", en: "Is signed", hi: "हस्ताक्षरित है" },
};

/** The type of a catalogue key, or null for anything else (own-property lookup: prototype names are never fields). */
export function fieldType(key: string): FieldType | null {
  return Object.hasOwn(TEMPLATE_FIELDS, key) ? TEMPLATE_FIELDS[key as FieldKey].type : null;
}
