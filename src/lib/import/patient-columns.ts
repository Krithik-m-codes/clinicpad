import { z } from "zod";

export const IMPORT_FIELDS = ["name", "phone", "dob", "gender", "address", "allergies", "notes"] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number];
/** Which column (0-based) holds each field; null = not imported. */
export type ColumnMapping = Record<ImportField, number | null>;

export const IMPORT_FIELD_LABELS: Record<ImportField, string> = {
  name: "Name",
  phone: "Phone",
  dob: "Date of birth",
  gender: "Gender",
  address: "Address",
  allergies: "Allergies",
  notes: "Notes",
};

/** Header spellings seen in clinic spreadsheets and the legacy app (compared with headerKey). */
const ALIASES: Record<ImportField, readonly string[]> = {
  name: ["name", "patientname", "fullname", "patient", "nameofpatient", "naam", "नाम"],
  phone: ["phone", "phoneno", "phonenumber", "mobile", "mobileno", "mobilenumber", "contact", "contactno", "contactnumber", "whatsapp", "whatsappno", "cell", "मोबाइल", "फोन"],
  dob: ["dob", "dateofbirth", "birthdate", "birthday", "dobddmmyyyy"],
  gender: ["gender", "sex", "लिंग"],
  address: ["address", "addr", "fulladdress", "residence", "पता"],
  allergies: ["allergies", "allergy", "drugallergy", "drugallergies", "allergic"],
  notes: ["notes", "note", "remarks", "remark", "comments", "comment"],
};
const AGE_ALIASES: readonly string[] = ["age", "ageyears", "ageinyears", "उम्र", "आयु"];

/** Case, spaces and punctuation ignored: "Mobile No." and "mobile_no" both read "mobileno". */
export function headerKey(header: string): string {
  return header.normalize("NFC").toLowerCase().replace(/[^\p{L}\p{M}\p{N}]/gu, "");
}

/** A first guess at the mapping: each field takes the first unused column whose header it recognises. */
export function suggestMapping(headers: readonly string[]): ColumnMapping {
  const keys = headers.map(headerKey);
  const used = new Set<number>();
  const mapping: ColumnMapping = { name: null, phone: null, dob: null, gender: null, address: null, allergies: null, notes: null };
  for (const field of IMPORT_FIELDS) {
    const index = keys.findIndex((key, i) => !used.has(i) && ALIASES[field].includes(key));
    if (index >= 0) {
      mapping[field] = index;
      used.add(index);
    }
  }
  return mapping;
}

/** Unmapped columns that hold an age: reported, because a birth date is never invented from an age. */
export function ageColumns(headers: readonly string[], mapping: ColumnMapping): string[] {
  const mapped = new Set(Object.values(mapping));
  return headers.filter((header, i) => !mapped.has(i) && AGE_ALIASES.includes(headerKey(header)));
}

const column = z.number().int().min(0).nullable();
const mappingSchema = z.strictObject({ name: column, phone: column, dob: column, gender: column, address: column, allergies: column, notes: column });

/** A mapping sent back by the browser: every field present, a name column chosen, existing columns, each used once. */
export function checkMapping(raw: unknown, headerCount: number): { ok: true; mapping: ColumnMapping } | { ok: false; message: string } {
  const parsed = mappingSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, message: "Choose which column holds each detail." };
  const mapping = parsed.data;
  if (mapping.name === null) return { ok: false, message: "Choose the column that holds the patient's name." };
  const used = IMPORT_FIELDS.map((f) => mapping[f]).filter((i): i is number => i !== null);
  if (used.some((i) => i >= headerCount)) return { ok: false, message: "A chosen column does not exist in this file." };
  if (new Set(used).size !== used.length) return { ok: false, message: "Each column can be used for one detail only." };
  return { ok: true, mapping };
}

/** The documented import shape (sample_data/patients_template.csv is serializeCsv of this). Synthetic people only. */
export const PATIENT_TEMPLATE_ROWS: readonly (readonly string[])[] = [
  ["name", "phone", "dob", "gender", "address", "allergies", "notes"],
  ["Asha Rao", "90000 00001", "15/08/1990", "female", "12 MG Road, Pune", "Penicillin; Sulfa", ""],
  ["Ravi Kumar", "90000 00002", "1985-01-20", "male", "", "", "Diabetic, on insulin"],
  ["आशा देवी", "90000 00003", "", "female", "", "", ""],
];
