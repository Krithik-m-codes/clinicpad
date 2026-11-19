import { BACKGROUND_LIMITS, IMAGE_LIMITS } from "@/lib/domain/image";
import { overlayGeometryIssues, type OverlayDefinition } from "@/lib/rx-render/overlay-definition";
import { MAX_DOCUMENT_CHARS } from "@/lib/rx-render/self-contained";
import type { PaperSize } from "@/lib/rx-render/types";

/** How the publisher answered "does the printed letterhead show a doctor's name or registration number?" (decision 19). */
export type PublishIdentity = { kind: "dynamic" } | { kind: "bound"; doctorId: string | null; confirmed: boolean };
export type PublishIssueCode =
  | "geometry"
  | "box_overlap"
  | "missing_patient_name"
  | "missing_date"
  | "missing_medicines"
  | "doctor_identity"
  | "bound_doctor"
  | "bound_confirmation"
  | "signature_twice"
  | "document_too_large";
export type PublishIssue = { code: PublishIssueCode; message: string };

/** Known sizes of the assets a publish embeds; omitted means "assume the largest allowed background". */
export type PublishAssets = { backgroundBytes: number };

/** Characters of base64 for n bytes (padded). */
export function base64Chars(bytes: number): number {
  return 4 * Math.ceil(bytes / 3);
}

/**
 * Upper bound on the inlined @font-face CSS (Noto Sans Devanagari 400 and 700, three subsets each, base64 in data:
 * URIs). tests/unit/publish-rules.test.ts checks it against the real stylesheet and that it stays a tight bound.
 */
export const EMBEDDED_FONT_CHARS = 200_000;
/** Room for the document markup, CSS and the text of a long prescription (override 3). */
export const MARKUP_MARGIN_CHARS = 300 * 1024;

/**
 * Worst case length of an overlay document: the background, one logo and one signature at their size caps (a pad
 * has at most one box for each), the embedded fonts, and a markup margin. Must stay under MAX_DOCUMENT_CHARS or
 * checkSelfContained refuses to print the pad.
 */
export function estimateOverlayDocumentChars(backgroundBytes: number): number {
  return base64Chars(backgroundBytes) + 2 * base64Chars(IMAGE_LIMITS.maxBytes) + EMBEDDED_FONT_CHARS + MARKUP_MARGIN_CHARS;
}

const EPSILON = 0.05;

function overlappingBoxes(def: OverlayDefinition): string[][] {
  const pairs: string[][] = [];
  for (let i = 0; i < def.boxes.length; i++) {
    for (let j = i + 1; j < def.boxes.length; j++) {
      const a = def.boxes[i];
      const b = def.boxes[j];
      const ox = Math.min(a.xMm + a.wMm, b.xMm + b.wMm) - Math.max(a.xMm, b.xMm);
      const oy = Math.min(a.yMm + a.hMm, b.yMm + b.hMm) - Math.max(a.yMm, b.yMm);
      if (ox > EPSILON && oy > EPSILON) pairs.push([a.id, b.id]);
    }
  }
  return pairs;
}

/** Everything that blocks publishing an overlay pad, in the order the editor shows them. Empty means publishable. */
export function overlayPublishIssues(
  def: OverlayDefinition,
  paperSize: PaperSize,
  identity: PublishIdentity,
  assets: PublishAssets = { backgroundBytes: BACKGROUND_LIMITS.maxBytes },
): PublishIssue[] {
  const fields = new Set<string>(def.boxes.map((box) => box.field));
  const issues: PublishIssue[] = overlayGeometryIssues(def, paperSize).map((g) => ({ code: "geometry", message: g.message }));
  for (const [a, b] of overlappingBoxes(def)) {
    issues.push({ code: "box_overlap", message: `The "${a}" and "${b}" boxes overlap. Move one so the text does not print over the other.` });
  }
  if (!fields.has("patient.name")) issues.push({ code: "missing_patient_name", message: "Add a box for the patient's name." });
  if (!fields.has("visit.date")) issues.push({ code: "missing_date", message: "Add a box for the date." });
  if (!def.flow.sections.includes("medicines")) issues.push({ code: "missing_medicines", message: "The body region must include the medicines." });
  // A PUBLISH rule (the frozen v1 parser accepts both): one signature image per pad, in the box or after the content.
  if (def.signature.mode === "end_of_content" && fields.has("doctor.signature")) {
    issues.push({ code: "signature_twice", message: "The signature would print twice. Show it in its box, or after the prescription, not both." });
  }
  if (identity.kind === "dynamic") {
    const printsDoctor = def.signature.mode === "end_of_content" || (fields.has("doctor.name") && fields.has("doctor.reg_no"));
    if (!printsDoctor) {
      issues.push({ code: "doctor_identity", message: "Print the doctor's name and registration number: add boxes for both, or show the signature block after the prescription." });
    }
  } else {
    if (!identity.doctorId) issues.push({ code: "bound_doctor", message: "Choose the doctor whose letterhead this is." });
    if (!identity.confirmed) issues.push({ code: "bound_confirmation", message: "Confirm that the letterhead shows this doctor's name and registration number." });
  }
  const bytes = assets.backgroundBytes;
  if (!Number.isFinite(bytes) || bytes < 0 || estimateOverlayDocumentChars(bytes) >= MAX_DOCUMENT_CHARS) {
    issues.push({ code: "document_too_large", message: "The background image is too large to print with this pad. Upload a smaller image." });
  }
  return issues;
}
