import { snapshotWithLayout, type RenderSnapshot } from "@/lib/rx-render/snapshot";
import type { ImageAsset, PadLayout, RxDocument, RxItem, RxVisit } from "@/lib/rx-render/types";

/** Text that must print literally: never markup, never a fetch. Non-printing characters are \u escapes. */
export const HOSTILE = {
  script: "<script>alert(1)</script>",
  img: '<img src=x onerror="alert(1)">',
  attrBreaker: '" onmouseover="alert(1)" x="',
  urls: 'src=http://evil.example/a url(http://evil.example/b) @import "http://evil.example/c";',
  bidi: "\u202Eevil\u202C",
  loneSurrogate: "a\uD800b\uDC00c",
  controls: "a\u0000b\u0007c\u001Fd",
  quotes: `Tom & Jerry's "syrup"`,
  longWord: "W".repeat(2000),
  long5000: "Lorem ipsum ".repeat(417).slice(0, 5000),
};

export const DEVANAGARI = {
  name: "आशा राव",
  complaint: "बुखार और खांसी",
  advice: Array.from({ length: 40 }, () => "भोजन के बाद दवा लें। पानी अधिक पिएं।").join(" "),
  /** Conjuncts joined and split with ZWJ (\u200D) and ZWNJ (\u200C), plus a plain conjunct. */
  conjuncts: "क्\u200Dष क्\u200Cष श्र त्र ज्ञ",
};

/** A 1x1 PNG; the renderer embeds base64 without decoding it. */
export const TINY_PNG: ImageAsset = {
  mime: "image/png",
  base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  width: 120,
  height: 60,
};

type SnapshotOverrides = {
  patient?: Partial<RenderSnapshot["patient"]>;
  clinic?: Partial<RenderSnapshot["clinic"]>;
  doctor?: Partial<RenderSnapshot["doctor"]>;
  layout?: Partial<PadLayout>;
};

/** Built-in pads freeze as version 1 (same shape as ever); only an overlay pad freezes as version 2 (Plan 2A override 4). */
export function snapshot(overrides: SnapshotOverrides = {}): RenderSnapshot {
  const layout: PadLayout = { template: { kind: "builtin", key: "general" }, paperSize: "A4", labels: "en", ...overrides.layout };
  const base = {
    takenAt: "2026-11-12T05:30:00.000Z",
    patient: {
      name: "Asha Rao",
      patientNo: 42,
      gender: "female",
      dob: "1990-04-02",
      ageLabel: "36 y",
      allergies: ["Penicillin"],
      ...overrides.patient,
    },
    clinic: {
      name: "Sunrise Family Clinic",
      addressLines: ["12 MG Road", "Pune, Maharashtra - 411001"],
      phone: "020-2612 3456",
      email: null,
      footerLines: ["Mon-Sat 9 am to 1 pm", "Please bring your previous prescriptions."],
      logoAssetId: null,
      timezone: "Asia/Kolkata",
      ...overrides.clinic,
    },
    doctor: {
      name: "Dr. Meera Shah",
      qualifications: "MBBS, MD (Medicine)",
      designation: "Consultant Physician",
      registrationNo: "MMC 2011/04/1234",
      registrationCouncil: "Maharashtra Medical Council",
      signatureAssetId: null,
      ...overrides.doctor,
    },
  };
  return snapshotWithLayout(base, layout);
}

export function item(n: number, overrides: Partial<RxItem> = {}): RxItem {
  return {
    drugName: `Medicine ${n}`,
    genericName: `Generic ${n}`,
    strength: "500 mg",
    form: "Tablet",
    route: "Oral",
    dose: "1 tab",
    doseMorning: 1,
    doseAfternoon: 0,
    doseEvening: null,
    doseNight: 1,
    timing: null,
    foodRelation: "after",
    periodicity: "daily",
    isSos: false,
    durationValue: 5,
    durationUnit: "days",
    durationDays: 5,
    remarks: null,
    ...overrides,
  };
}

export function manyItems(count: number): RxItem[] {
  return Array.from({ length: count }, (_, i) => item(i + 1));
}

export function visit(overrides: Partial<RxVisit> = {}): RxVisit {
  return {
    visitType: "new",
    chiefComplaint: "Fever for 2 days",
    complaints: ["Fever", "Body ache"],
    diagnosis: ["Viral fever"],
    medicalHistory: ["Type 2 diabetes"],
    drugHistory: ["Metformin 500"],
    examinationNotes: "Throat congested. Chest clear.",
    vitals: { bpSystolic: 130, bpDiastolic: 85, pulse: 92, temperatureF: 100.4, spo2: 97, weightKg: 70, heightCm: 175 },
    investigations: [{ name: "CBC" }, { name: "Dengue NS1", instructions: "If fever persists" }],
    advice: "Plenty of fluids.\nRest for 3 days.",
    followUpDate: "2026-11-19",
    followUpReason: "Review CBC report",
    ...overrides,
  };
}

/** A finalized General A4 prescription with three typical lines; override anything. */
export function documentFixture(overrides: Partial<RxDocument> & { layout?: Partial<PadLayout> } = {}): RxDocument {
  const { layout, ...rest } = overrides;
  return {
    status: "finalized",
    rxNo: 12,
    version: 1,
    issuedAt: "2026-11-12T05:30:00.000Z",
    supersededBy: null,
    replacesVersion: null,
    snapshot: snapshot({ layout }),
    snapshotSource: "finalize",
    visit: visit(),
    items: [
      item(1),
      item(2, {
        drugName: "Cetirizine",
        doseMorning: null,
        doseAfternoon: null,
        doseNight: 1,
        isSos: true,
        foodRelation: null,
        periodicity: "as_needed",
      }),
      item(3, {
        drugName: "ORS sachet",
        doseMorning: null,
        doseAfternoon: null,
        doseNight: null,
        timing: "After every loose stool",
        foodRelation: null,
        durationValue: 3,
        durationDays: 3,
      }),
    ],
    ...rest,
  };
}

/** The same document on another layout (paper, labels or template), paired with the right snapshot version. */
export function withLayout(doc: RxDocument, layout: Partial<PadLayout>): RxDocument {
  const { layout: current, ...rest } = doc.snapshot;
  const parts = { takenAt: rest.takenAt, patient: rest.patient, clinic: rest.clinic, doctor: rest.doctor };
  return { ...doc, snapshot: snapshotWithLayout(parts, { ...current, ...layout }) };
}
