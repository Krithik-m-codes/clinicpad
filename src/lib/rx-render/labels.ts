import { FOOD_RELATION_LABELS, PERIODICITY_LABELS, type FoodRelation, type Periodicity } from "@/lib/domain/rx-options";
import { translations } from "@/lib/translations";
import { numberText } from "./format";
import { html, type SafeHtml } from "./html";
import type { LabelLanguage } from "./types";

const hi = translations.hindi;

/*
 * NEEDS NATIVE-SPEAKER REVIEW before wide release (Hindi wording not confirmed):
 *   when = "कब", howToUse = "उपयोग विधि", rxNo = "पर्चा क्रमांक", bloodSugar = "शुगर",
 *   temperature = "तापमान" (consider "ताप"), respiratoryRate = "श्वसन दर", weight = "वजन",
 *   noon and afternoon are both "दोपहर" in the legacy strings.
 * followUp: the legacy followUpDate string means "next meeting" (अगली मुलाकात); a pad heading for a
 *   follow-up visit is "पुनः जांच" (re-examination), chosen here instead.
 */

/** Pad headings. Hindi comes from src/lib/translations.ts wherever the legacy app already had it. */
export const LABELS = {
  name: { en: "Name", hi: hi.name },
  age: { en: "Age", hi: hi.age },
  gender: { en: "Gender", hi: hi.gender },
  patientNo: { en: "Patient No.", hi: "रोगी क्रमांक" },
  date: { en: "Date", hi: hi.date },
  rxNo: { en: "Rx No.", hi: "पर्चा क्रमांक" },
  phone: { en: "Ph.", hi: "फोन" },
  allergies: { en: "Allergies", hi: hi.allergies },
  chiefComplaint: { en: "Chief complaint", hi: "मुख्य शिकायत" },
  complaints: { en: "Complaints", hi: hi.patientComplaints },
  medicalHistory: { en: "Medical history", hi: hi.medicalHistory },
  drugHistory: { en: "Drug history", hi: hi.drugHistory },
  examination: { en: "Examination", hi: "परीक्षण" },
  diagnosis: { en: "Diagnosis", hi: hi.diagnosis },
  medicine: { en: "Medicine", hi: hi.medicine },
  dose: { en: "Dose", hi: hi.dosage },
  when: { en: "When", hi: "कब" },
  morning: { en: "Mor", hi: hi.mor },
  afternoon: { en: "Noon", hi: hi.noon },
  evening: { en: "Eve", hi: hi.eve },
  night: { en: "Night", hi: hi.night },
  food: { en: "Food", hi: hi.food },
  frequencyDuration: { en: "Frequency / Duration", hi: hi.frequencyDuration },
  duration: { en: "Duration", hi: hi.duration },
  howToUse: { en: "How to use", hi: "उपयोग विधि" },
  instructions: { en: "Instructions", hi: hi.instructions },
  remarks: { en: "Remarks", hi: hi.remarks },
  investigations: { en: "Investigations", hi: hi.tests },
  advice: { en: "Advice", hi: "सलाह" },
  followUp: { en: "Follow-up", hi: "पुनः जांच" },
  regNo: { en: "Reg. No.", hi: "रजि. नं." },
  bp: { en: "BP", hi: hi.bp },
  pulse: { en: "Pulse", hi: "पल्स" },
  temperature: { en: "Temp", hi: "तापमान" },
  spo2: { en: "SpO2", hi: "SpO2" },
  respiratoryRate: { en: "RR", hi: "श्वसन दर" },
  weight: { en: "Weight", hi: "वजन" },
  height: { en: "Height", hi: "लंबाई" },
  bmi: { en: "BMI", hi: "BMI" },
  bloodSugar: { en: "Sugar", hi: "शुगर" },
} as const satisfies Record<string, { en: string; hi: string }>;

export type LabelKey = keyof typeof LABELS;

function pick(en: string, hindi: string, lang: LabelLanguage): string {
  if (lang === "en") return en;
  if (lang === "hi") return hindi;
  return en === hindi ? en : `${en} / ${hindi}`;
}

export function labelText(key: LabelKey, lang: LabelLanguage): string {
  return pick(LABELS[key].en, LABELS[key].hi, lang);
}

/** Table headings: bilingual stacks the Hindi under the English. */
export function labelHtml(key: LabelKey, lang: LabelLanguage): SafeHtml {
  const { en, hi: hindi } = LABELS[key];
  if (lang !== "bilingual" || en === hindi) return html`${pick(en, hindi, lang)}`;
  return html`<span class="l-en">${en}</span><span class="l-hi">${hindi}</span>`;
}

const HI_FOOD: Record<FoodRelation, string> = {
  before: hi.before,
  after: hi.after,
  with: hi.with,
  without: hi.without,
  with_tea: hi.with_tea,
  just_for_now: hi.just_for_now,
  according_to_pain: hi.according_to_pain,
};

const HI_PERIODICITY: Record<Periodicity, string> = {
  daily: hi.daily,
  alternate_day: hi.alternate,
  twice_weekly: hi.weeklyTwice,
  weekly: hi.weekly,
  every_5th_day: hi.every_5th_day,
  fortnightly: hi.fortnightly,
  monthly: hi.monthly,
  as_needed: hi.asNeeded,
};

const GENDER: Record<string, { en: string; hi: string }> = {
  female: { en: "Female", hi: hi.female },
  male: { en: "Male", hi: hi.male },
  other: { en: "Other", hi: hi.other },
};

function coded<K extends string>(
  code: string | null,
  en: Record<K, string>,
  hindi: Record<K, string>,
  lang: LabelLanguage,
): string {
  if (!code) return "";
  if (!Object.hasOwn(en, code)) return code; // unknown code: print it as text (it is escaped later)
  return pick(en[code as K], hindi[code as K], lang);
}

export function foodText(code: string | null, lang: LabelLanguage): string {
  return coded(code, FOOD_RELATION_LABELS, HI_FOOD, lang);
}

export function periodicityText(code: string | null, lang: LabelLanguage): string {
  return coded(code, PERIODICITY_LABELS, HI_PERIODICITY, lang);
}

export function genderText(code: string | null, lang: LabelLanguage): string {
  if (!code || !Object.hasOwn(GENDER, code)) return "";
  return pick(GENDER[code].en, GENDER[code].hi, lang);
}

const UNIT_WORDS: Record<string, { en: [string, string]; hi: [string, string] }> = {
  days: { en: ["day", "days"], hi: ["दिन", "दिन"] },
  weeks: { en: ["week", "weeks"], hi: ["सप्ताह", "सप्ताह"] },
  months: { en: ["month", "months"], hi: ["महीना", "महीने"] },
};

/** Longest duration printed; anything beyond is treated as damaged input. */
const DURATION_CAP = 9999;

/**
 * "5 days" / "5 दिन" / both. Empty for a missing, non-finite, zero, negative or absurd value.
 * An unknown or missing unit reads as days.
 */
export function durationText(value: number | null, unit: string | null, lang: LabelLanguage): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > DURATION_CAP) return "";
  const amount = numberText(value, 2);
  if (amount === "" || amount === "0") return "";
  const words = unit !== null && Object.hasOwn(UNIT_WORDS, unit) ? UNIT_WORDS[unit] : UNIT_WORDS.days;
  const one = amount === "1";
  return pick(`${amount} ${one ? words.en[0] : words.en[1]}`, `${amount} ${one ? words.hi[0] : words.hi[1]}`, lang);
}

const HI_AGE_UNITS: Record<string, string> = { y: "वर्ष", mo: "माह", d: "दिन" };

/** Plan 1A's ageLabel ("6 y", "15 mo", "11 d") in the label language. */
export function ageText(label: string, lang: LabelLanguage): string {
  const match = /^(\d+) (y|mo|d)$/.exec(label);
  if (!match) return label;
  return pick(label, `${match[1]} ${HI_AGE_UNITS[match[2]]}`, lang);
}

/*
 * NEEDS NATIVE-SPEAKER REVIEW before wide release: every Hindi string in the status texts below
 * (draft, superseded, amendment and legacy-note wording) is a first draft, not confirmed.
 */

const STATUS_TEXT = {
  draftWatermark: { en: "DRAFT · NOT VALID FOR DISPENSING", hi: "मसौदा · दवा देने के लिए मान्य नहीं" },
  draftBanner: {
    en: "DRAFT PREVIEW · This is not a prescription until it is finalized.",
    hi: "मसौदा पूर्वावलोकन · अंतिम रूप दिए जाने तक यह पर्चा नहीं है।",
  },
  supersededWatermark: { en: "SUPERSEDED", hi: "निरस्त" },
  supersededNewer: {
    en: "SUPERSEDED by a newer version. Do not dispense from this copy.",
    hi: "नए संस्करण द्वारा निरस्त। इस प्रति से दवा न दें।",
  },
  legacyNote: {
    en: "Printed with the clinic, doctor and patient details on file today: this prescription was finalized before print snapshots were recorded.",
    hi: "आज दर्ज क्लिनिक, चिकित्सक और रोगी विवरण के साथ मुद्रित: यह पर्चा प्रिंट स्नैपशॉट दर्ज होने से पहले अंतिम किया गया था।",
  },
} as const satisfies Record<string, { en: string; hi: string }>;

export type StatusTextKey = keyof typeof STATUS_TEXT;

export function statusText(key: StatusTextKey, lang: LabelLanguage): string {
  return pick(STATUS_TEXT[key].en, STATUS_TEXT[key].hi, lang);
}

/** "SUPERSEDED by version 2 issued 13/11/2026. Do not dispense from this copy." */
export function supersededByText(version: number, issued: string, lang: LabelLanguage): string {
  const en = `SUPERSEDED by version ${version}${issued ? ` issued ${issued}` : ""}. Do not dispense from this copy.`;
  const hindi = `संस्करण ${version} द्वारा निरस्त${issued ? `, जारी दिनांक ${issued}` : ""}। इस प्रति से दवा न दें।`;
  return pick(en, hindi, lang);
}

export function replacesVersionText(version: number, lang: LabelLanguage): string {
  return pick(`Replaces version ${version}`, `संस्करण ${version} का स्थान लेता है`, lang);
}

export function draftAmendmentText(version: number, lang: LabelLanguage): string {
  return pick(`Draft amendment of version ${version}`, `संस्करण ${version} का संशोधन मसौदा`, lang);
}
