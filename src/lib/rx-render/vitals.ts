import type { Vitals } from "@/lib/domain/rx-options";
import { bmiText, bpText, numberText } from "./format";
import type { LabelKey } from "./labels";
import type { VitalKey } from "./templates";

export const VITAL_LABEL: Record<VitalKey, LabelKey> = {
  bp: "bp",
  pulse: "pulse",
  temperatureF: "temperature",
  spo2: "spo2",
  respiratoryRate: "respiratoryRate",
  weightKg: "weight",
  heightCm: "height",
  bmi: "bmi",
  bloodSugarMgDl: "bloodSugar",
};

/** "70 kg", or null for a missing, damaged, zero or negative reading. */
function withUnit(value: number | undefined, decimals: number, unit: string): string | null {
  const text = numberText(value, decimals);
  return text === "" || text === "0" || text.startsWith("-") ? null : `${text}${unit}`;
}

const VITAL_VALUE: Record<VitalKey, (v: Vitals) => string | null> = {
  bp: (v) => {
    const bp = bpText(v.bpSystolic, v.bpDiastolic);
    return bp === "" ? null : `${bp} mmHg`;
  },
  pulse: (v) => withUnit(v.pulse, 0, "/min"),
  temperatureF: (v) => withUnit(v.temperatureF, 1, " °F"),
  spo2: (v) => withUnit(v.spo2, 0, "%"),
  respiratoryRate: (v) => withUnit(v.respiratoryRate, 0, "/min"),
  weightKg: (v) => withUnit(v.weightKg, 1, " kg"),
  heightCm: (v) => withUnit(v.heightCm, 1, " cm"),
  bmi: (v) => {
    const index = bmiText(v.weightKg, v.heightCm);
    return index === "" || index === "0" ? null : index;
  },
  bloodSugarMgDl: (v) => withUnit(v.bloodSugarMgDl, 0, " mg/dL"),
};

/** The formatted reading ("130/85 mmHg"), or null when missing or implausible. */
export function vitalText(key: VitalKey, v: Vitals): string | null {
  return VITAL_VALUE[key](v);
}
