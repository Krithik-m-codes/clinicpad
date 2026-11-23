import type { RenderSnapshot } from "./snapshot";
import type { RxDocument, RxItem, RxVisit } from "./types";

export const SAMPLE_KINDS = ["short", "long", "blank"] as const;
export type SampleKind = (typeof SAMPLE_KINDS)[number];

const med = (drugName: string, strength: string, form: string, slots: [number, number, number, number] | null, rest: Partial<RxItem> = {}): RxItem => ({
  drugName,
  genericName: null,
  strength,
  form,
  route: null,
  dose: null,
  doseMorning: slots ? slots[0] : null,
  doseAfternoon: slots ? slots[1] : null,
  doseEvening: slots ? slots[2] : null,
  doseNight: slots ? slots[3] : null,
  timing: null,
  foodRelation: "after",
  periodicity: "daily",
  isSos: false,
  durationValue: 5,
  durationUnit: "days",
  durationDays: 5,
  remarks: null,
  ...rest,
});

/** Typical Indian outpatient lines (fake data for previews). */
const SAMPLE_ITEMS: RxItem[] = [
  med("Paracetamol", "650 mg", "Tablet", [1, 0, 0, 1]),
  med("Pantoprazole", "40 mg", "Tablet", [1, 0, 0, 0], { foodRelation: "before", durationValue: 14, durationDays: 14 }),
  med("Cetirizine", "10 mg", "Tablet", [0, 0, 0, 1]),
  med("Amoxicillin + Clavulanic acid", "625 mg", "Tablet", [1, 0, 0, 1], { remarks: "Complete the full course" }),
  med("Azithromycin", "500 mg", "Tablet", [1, 0, 0, 0], { durationValue: 3, durationDays: 3 }),
  med("Cholecalciferol", "60,000 IU", "Sachet", null, { periodicity: "weekly", timing: "Once a week with milk", durationValue: 8, durationUnit: "weeks", durationDays: 56 }),
  med("Oral rehydration salts", "21 g", "Sachet", null, { isSos: true, periodicity: "as_needed", timing: "After each loose stool" }),
  med("Ibuprofen", "400 mg", "Tablet", null, { isSos: true, periodicity: "as_needed", timing: "If pain is severe" }),
  med("Montelukast", "10 mg", "Tablet", [0, 0, 0, 1], { durationValue: 14, durationDays: 14 }),
  med("Calcium carbonate", "500 mg", "Tablet", [0, 1, 0, 0], { durationValue: 1, durationUnit: "months", durationDays: 30 }),
  med("Metformin", "500 mg", "Tablet", [1, 0, 0, 1], { durationValue: 1, durationUnit: "months", durationDays: 30 }),
  med("Levocetirizine", "2.5 mg/5 ml", "Syrup", null, { dose: "5 ml", timing: "At bedtime" }),
];

const EMPTY_VISIT: RxVisit = {
  visitType: "new",
  chiefComplaint: null,
  complaints: [],
  diagnosis: [],
  medicalHistory: [],
  drugHistory: [],
  examinationNotes: null,
  vitals: {},
  investigations: [],
  advice: null,
  followUpDate: null,
  followUpReason: null,
};

/** Never a real doctor: sample previews print this placeholder (Plan 2A override 13). */
export const SAMPLE_DOCTOR: RenderSnapshot["doctor"] = {
  name: "Dr. Sample Doctor",
  qualifications: "MBBS, MD",
  designation: "Consultant",
  registrationNo: "SAMPLE-0000",
  registrationCouncil: "Sample Medical Council",
  signatureAssetId: null,
};

/**
 * A fake prescription on the clinic's real letterhead details, for template previews only (never a record, never
 * logged). It has NO Rx number, no signature image, and a placeholder doctor (never a real doctor's name or
 * registration); the "SAMPLE" banner is drawn by the preview renderer.
 */
export function sampleDocument(kind: SampleKind, base: RenderSnapshot): RxDocument {
  const doctor = SAMPLE_DOCTOR;
  const common = {
    status: "finalized" as const,
    version: 1,
    issuedAt: base.takenAt,
    supersededBy: null,
    replacesVersion: null,
    snapshotSource: "finalize" as const,
  };
  if (kind === "blank") {
    return {
      ...common,
      rxNo: null,
      snapshot: { ...base, doctor, patient: { name: "", patientNo: null, gender: null, dob: null, ageLabel: "", allergies: [] } },
      visit: EMPTY_VISIT,
      items: [],
    };
  }
  if (kind === "short") {
    return {
      ...common,
      rxNo: null,
      snapshot: { ...base, doctor, patient: { name: "Asha Rao", patientNo: 42, gender: "female", dob: "1990-04-02", ageLabel: "36 y", allergies: ["Penicillin"] } },
      visit: { ...EMPTY_VISIT, chiefComplaint: "Fever for 2 days", diagnosis: ["Viral fever"], vitals: { bpSystolic: 124, bpDiastolic: 82, pulse: 88, temperatureF: 100.2, weightKg: 62 }, advice: "Plenty of fluids. Rest for 3 days.", followUpDate: null, followUpReason: "If fever persists after 3 days" },
      items: SAMPLE_ITEMS.slice(0, 3),
    };
  }
  return {
    ...common,
    rxNo: null,
    snapshot: {
      ...base,
      doctor,
      patient: { name: "श्रीमती अन्नपूर्णा देवी रामचंद्रन सुब्रमण्यम", patientNo: 10234, gender: "female", dob: "1958-01-15", ageLabel: "68 y", allergies: ["Penicillin", "Sulfa drugs", "Peanuts"] },
    },
    visit: {
      ...EMPTY_VISIT,
      chiefComplaint: "बुखार और खांसी, 5 दिनों से",
      complaints: ["Fever", "Dry cough", "Body ache", "Loss of appetite"],
      diagnosis: ["Lower respiratory tract infection", "Type 2 diabetes mellitus"],
      medicalHistory: ["Type 2 diabetes for 10 years", "Hypertension"],
      vitals: { bpSystolic: 146, bpDiastolic: 92, pulse: 102, temperatureF: 101.4, spo2: 95, respiratoryRate: 22, weightKg: 71.5, heightCm: 158, bloodSugarMgDl: 214 },
      investigations: [{ name: "CBC" }, { name: "Chest X-ray PA view" }, { name: "HbA1c", instructions: "Fasting not needed" }],
      advice: Array.from({ length: 6 }, () => "भोजन के बाद दवा लें। पानी अधिक पिएं। आराम करें।").join(" "),
      followUpReason: "Review with X-ray and blood reports",
    },
    items: SAMPLE_ITEMS,
  };
}

/** Long clinic and doctor values for the editor's overflow warnings (never printed, never a real clinic). */
export const SAMPLE_LETTERHEAD: Extract<RenderSnapshot, { v: 1 }> = {
  v: 1,
  takenAt: "2026-11-18T05:30:00.000Z",
  patient: { name: "", patientNo: null, gender: null, dob: null, ageLabel: "", allergies: [] },
  clinic: {
    name: "Shri Annapurna Multispeciality Clinic and Diagnostic Centre",
    addressLines: ["Shop 4-5, Ground Floor, Sai Krupa Complex, Near Railway Station Road", "Kalyan (West), Thane, Maharashtra - 421301"],
    phone: "0251-2345678, 98765 43210",
    email: "appointments@annapurnaclinic.example",
    footerLines: ["Mon-Sat 10 am to 1 pm and 5 pm to 9 pm · Sunday closed"],
    logoAssetId: null,
    timezone: "Asia/Kolkata",
  },
  doctor: {
    name: "Dr. Venkataraman Subramaniam Ramachandran",
    qualifications: "MBBS, MD (General Medicine), DNB (Cardiology), FACC",
    designation: "Senior Consultant Physician and Cardiologist",
    registrationNo: "MMC 2011/04/123456",
    registrationCouncil: "Maharashtra Medical Council",
    signatureAssetId: null,
  },
  layout: { template: { kind: "builtin", key: "general" }, paperSize: "A4", labels: "en" },
};
