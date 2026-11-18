import type { Investigation, Vitals } from "@/lib/domain/rx-options";
import type { OverlayDefinition } from "./overlay-definition";
import type { RenderSnapshot } from "./snapshot";

export const BUILTIN_TEMPLATES = ["general", "paediatric", "derma"] as const;
export type BuiltinTemplateKey = (typeof BUILTIN_TEMPLATES)[number];

export const PAPER_SIZES = ["A4", "A5"] as const;
export type PaperSize = (typeof PAPER_SIZES)[number];

export const LABEL_LANGUAGES = ["en", "hi", "bilingual"] as const;
export type LabelLanguage = (typeof LABEL_LANGUAGES)[number];

/** Which template draws the pad: a built-in key, or a frozen custom version (Plan 2A). Phase 2B adds "docx". */
export type TemplateRef = RenderSnapshot["layout"]["template"];
export type OverlayTemplateRef = Extract<TemplateRef, { kind: "overlay" }>;

/** Which pad, paper and labels. A looser shape than the snapshot's own layout: snapshotWithLayout() pairs it with the right version. */
export type PadLayout = { template: TemplateRef; paperSize: PaperSize; labels: LabelLanguage };

export type RxStatus = "draft" | "finalized" | "amended";

/** The clinical content a pad prints (a subset of Plan 1B's ClinicalVisitView). */
export type RxVisit = {
  visitType: string;
  chiefComplaint: string | null;
  complaints: string[];
  diagnosis: string[];
  medicalHistory: string[];
  drugHistory: string[];
  examinationNotes: string | null;
  vitals: Vitals;
  investigations: Investigation[];
  advice: string | null;
  followUpDate: string | null;
  followUpReason: string | null;
};

/** One medicine line (the same fields as Plan 1B's ItemView). */
export type RxItem = {
  drugName: string;
  genericName: string | null;
  strength: string | null;
  form: string | null;
  route: string | null;
  dose: string | null;
  doseMorning: number | null;
  doseAfternoon: number | null;
  doseEvening: number | null;
  doseNight: number | null;
  timing: string | null;
  foodRelation: string | null;
  periodicity: string | null;
  isSos: boolean;
  durationValue: number | null;
  durationUnit: string | null;
  durationDays: number | null;
  remarks: string | null;
};

/** Everything the renderer needs. Built by loadRxDocument(); fixtures build it directly. */
export type RxDocument = {
  status: RxStatus;
  rxNo: number | null;
  version: number;
  /** finalized_at as ISO, null for drafts. */
  issuedAt: string | null;
  /** Set when a newer finalized version replaced this one. */
  supersededBy: { version: number; issuedAt: string | null } | null;
  /** Set on amendments: the version this one replaces. */
  replacesVersion: number | null;
  snapshot: RenderSnapshot;
  /** "finalize" = frozen at finalize; "live" = built from current data (drafts, pre-1C rows). */
  snapshotSource: "finalize" | "live";
  visit: RxVisit;
  items: RxItem[];
};

export type ImageAsset = { mime: "image/png" | "image/jpeg"; base64: string; width: number; height: number };

/** screen: in-app preview. print: paper (printer offset; no background on pre-printed stationery). pdf: digital copy. */
export type RenderTarget = "screen" | "print" | "pdf";

/** A custom overlay pad, loaded and hash-verified by the server (template-resolution.ts) before rendering. */
export type OverlayInput = { templateVersionId: string; definition: OverlayDefinition; background: ImageAsset };

export type RenderAssets = { logo: ImageAsset | null; signature: ImageAsset | null; fontCss: string; overlay?: OverlayInput | null };

export type PaperSpec = {
  size: PaperSize;
  widthMm: number;
  heightMm: number;
  widthIn: number;
  heightIn: number;
  marginMm: { top: number; right: number; bottom: number; left: number };
  baseFontPt: number;
};

/** Output of every template kind. Phase 2's DOCX kind adds { format: "docx"; bytes } to this union. */
export type RenderedDocument = { format: "html"; html: string; footerHtml: string; paper: PaperSpec; title: string };

/** `value` if it is one of `options`, else `fallback`. For codes read from the database. */
export function pickOption<T extends string>(options: readonly T[], value: string | null | undefined, fallback: T): T {
  return value !== null && value !== undefined && (options as readonly string[]).includes(value) ? (value as T) : fallback;
}
