// Medicine interface with enhanced fields
export interface Medicine {
  id: string;
  name: string; // example -- TAB PARACETAMOL XL 500MG --
  salt?: string; // example -- PARACETAMOL --
  duration: {
    days: number; // number of days
    months?: number; // optional months
    years?: number; // optional years
    type: "days" | "months" | "years"; // duration type
  };
  remark: string; // remark for user
  timing: {
    morning: number; // QUANTITY OF TABLETS
    afternoon: number; // QUANTITY OF TABLETS
    evening: number; // QUANTITY OF TABLETS
    night: number; // 0 if not taken, else quantity of tablets
  };
  foodTiming:
    | "before"
    | "after"
    | "with"
    | "without"
    | "with_tea"
    | "just_for_now"
    | "according_to_pain"; // with food, before food, after food, without food, with tea & snacks, just for now, according to pain
  sos?: boolean; // SOS (if needed) indication
  periodicity: string; // Daily, Weekly, etc.
  startDate: string; // start date of the medicine
}

// Patient information interface with medical history
export interface PatientInfo {
  title: string; // Mr., Mrs., Ms., Master, Baby
  patientName: string;
  age: string;
  gender: string;
  weight: string;
  // height: string;  // not required
  allergies: string;
  diagnosis: string[]; // Array of diagnosis names
  patientComplaints: string[]; // Array of complaint names
  followUpDate: string;
  medicalHistory: string[]; // Array of medical history names
  drugHistory: string[]; // Array of previously prescribed medicines
}

// Vital signs interface
export interface VitalSigns {
  spo2: string;
  pulse: string;
  temp: string;
  bp: string;
}

// Test interface
export interface Test {
  id: string;
  name: string;
  instructions: string;
}

// Doctor signature interface
export interface DoctorSignature {
  name: string;
  // qualification: string;
  // registrationNo: string;
  signature: string; // Base64 image or text
}

// Complete prescription form data
export interface PrescriptionFormData {
  patient: PatientInfo;
  vitals: VitalSigns;
  medicines: Medicine[];
  tests: Test[];
  selectedTests: string[]; // Array of selected test names for multi-select
  date: string;
  nextReview: string;
  doctorSignature: DoctorSignature;
  remarks: string;
}

// Language type
export type Language = "hindi" | "english";

// Print/Export options
export interface ExportOptions {
  format: "pdf" | "print";
  pageBreak: boolean;
}

// Zod validation schema
import { z } from "zod";

export const MedicineSchema = z.object({
  id: z.string(),
  name: z.string().min(1, "Medicine name is required"),
  duration: z.object({
    days: z.number().min(1, "Duration in days is required"),
    months: z.number().optional(),
    years: z.number().optional(),
    type: z.enum(["days", "months", "years"]),
  }),
  remark: z.string(),
  timing: z.object({
    morning: z.number().min(0, "Morning quantity must be 0 or more"),
    afternoon: z.number().min(0, "Afternoon quantity must be 0 or more"),
    evening: z.number().min(0, "Evening quantity must be 0 or more"),
    night: z.number().min(0, "Night quantity must be 0 or more"),
  }),
  foodTiming: z.enum([
    "before",
    "after",
    "with",
    "without",
    "with_tea",
    "just_for_now",
    "according_to_pain",
  ]),
  sos: z.boolean().optional(),
  periodicity: z.string(),
  startDate: z.string(),
});

export const PatientInfoSchema = z.object({
  patientName: z.string().optional(),
  age: z.string().optional(),
  gender: z.string().optional(),
  weight: z.string().optional(),
  height: z.string().optional(),
  allergies: z.string().optional(),
  diagnosis: z.array(z.string()).optional(),
  patientComplaints: z.array(z.string()).optional(),
  notes: z.string().optional(),
  followUpDate: z.string().optional(),
  medicalHistory: z.array(z.string()).optional(),
});

export const VitalSignsSchema = z.object({
  spo2: z.string().optional(),
  pulse: z.string().optional(),
  temp: z.string().optional(),
  bp: z.string().optional(),
});

export const TestSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  remarks: z.string().optional(),
});

export const DoctorSignatureSchema = z.object({
  name: z.string().optional(),
  qualification: z.string().optional(),
  registrationNo: z.string().optional(),
  signature: z.string().optional(),
});

export const PrescriptionFormDataSchema = z.object({
  patient: PatientInfoSchema,
  vitals: VitalSignsSchema,
  medicines: z
    .array(MedicineSchema)
    .min(1, "At least one medicine is required"),
  tests: z.array(TestSchema),
  date: z.string(),
  nextReview: z
    .string()
    .optional()
    .refine(
      (val) => {
        if (!val) return true; // Allow empty
        const selectedDate = new Date(val);
        const today = new Date();
        today.setHours(0, 0, 0, 0); // Set to start of today
        return selectedDate >= today;
      },
      {
        message: "Next review date must be today or in the future",
      }
    ),
  doctorSignature: DoctorSignatureSchema,
  remarks: z.string().optional(),
});
