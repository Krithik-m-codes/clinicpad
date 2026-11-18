import { z } from "zod";
import { BOX_FIELD_KEYS } from "./fields";
import { PAPER } from "./paper";
import type { SectionKey } from "./templates";
import { BUILTIN_TEMPLATES, type PaperSize } from "./types";

/**
 * An overlay pad (spec section 6.1): the clinic's background image with field boxes on top and one flow region where
 * the prescription body runs across pages. Lengths are millimetres from the page's top-left corner; flow insets are
 * measured from the matching page edge. Stored in template_versions.definition; parse it, never trust it.
 *
 * FROZEN (Plan 2A override 5): the v1 schema and geometry rules below must not change. Published versions are
 * hashed (sha256 of canonicalJson of the definition as stored) and reprinted by parsing with this parser without a
 * geometry re-check; tightening a rule would orphan stored pads and loosening one would change what "valid" means
 * for past hashes. A change is a new schema version (`v: 2`) with its own parser. The golden hash of
 * MINIMAL_OVERLAY_DEFINITION in tests/unit/overlay-definition.test.ts pins this.
 */
export const OVERLAY_LIMITS = {
  maxBoxes: 30,
  /** Image fields (logo, signature) are limited to one box each; other fields may repeat this many times. */
  maxBoxesPerField: 3,
  minBoxMm: 3,
  minFontPt: 6,
  maxFontPt: 24,
  minFlowHeightMm: 40,
  minFlowWidthMm: 60,
  maxOffsetMm: 10,
  minBandMm: 5,
  maxBandMm: 12,
  /** The repeating header and footer spacers of the flow table may take at most 24% of the paper height each (S1, override 16a). */
  maxSpacerMm: { A4: 71, A5: 50 },
} as const;

export const SECTION_KEYS = [
  "vitals", "chiefComplaint", "complaints", "medicalHistory", "drugHistory", "examination", "diagnosis", "medicines",
  "investigations", "advice", "followUp",
] as const satisfies readonly SectionKey[];

const tenth = (n: number) => Math.round(n * 10) / 10;
/** z.number() refuses NaN and Infinity; values are rounded to 0.1 so a stored definition hashes the same after a round trip. */
const mm = (min: number, max: number) => z.number().min(min).max(max).transform(tenth);

/** Length is checked on the untouched input first (z.array would walk every item), so a hostile array is refused in O(1). */
const cappedArray = <T extends z.ZodType>(item: T, min: number, max: number) =>
  z.custom<unknown[]>((value) => Array.isArray(value) && value.length >= min && value.length <= max).pipe(z.array(item));

const boxSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,24}$/),
  field: z.enum(BOX_FIELD_KEYS),
  xMm: mm(0, 210),
  yMm: mm(0, 297),
  wMm: mm(OVERLAY_LIMITS.minBoxMm, 210),
  hMm: mm(OVERLAY_LIMITS.minBoxMm, 297),
  fontPt: z.number().min(OVERLAY_LIMITS.minFontPt).max(OVERLAY_LIMITS.maxFontPt).transform(tenth),
  align: z.enum(["left", "center", "right"]),
  bold: z.boolean(),
  repeat: z.enum(["every_page", "first_page"]),
});

const IMAGE_FIELDS: ReadonlySet<string> = new Set(["clinic.logo", "doctor.signature"]);

export const overlayDefinitionSchema = z
  .object({
    v: z.literal(1),
    background: z.object({ printMode: z.enum(["always", "pdf_only"]) }),
    boxes: cappedArray(boxSchema, 0, OVERLAY_LIMITS.maxBoxes),
    flow: z.object({
      topMm: mm(0, 297),
      bottomMm: mm(0, 297),
      leftMm: mm(0, 210),
      rightMm: mm(0, 210),
      bodyStyle: z.enum(BUILTIN_TEMPLATES),
      sections: cappedArray(z.enum(SECTION_KEYS), 1, SECTION_KEYS.length),
      showRxMark: z.boolean(),
    }),
    signature: z.object({ mode: z.enum(["end_of_content", "box"]) }),
    pageNumbers: z.object({ bandMm: z.union([z.literal(0), mm(OVERLAY_LIMITS.minBandMm, OVERLAY_LIMITS.maxBandMm)]) }),
    printOffsetMm: z.object({ x: mm(-OVERLAY_LIMITS.maxOffsetMm, OVERLAY_LIMITS.maxOffsetMm), y: mm(-OVERLAY_LIMITS.maxOffsetMm, OVERLAY_LIMITS.maxOffsetMm) }),
  })
  .superRefine((def, ctx) => {
    const ids = new Set<string>();
    const perField = new Map<string, number>();
    def.boxes.forEach((box, i) => {
      if (ids.has(box.id)) ctx.addIssue({ code: "custom", message: "Two boxes have the same id.", path: ["boxes", i, "id"] });
      ids.add(box.id);
      const count = (perField.get(box.field) ?? 0) + 1;
      perField.set(box.field, count);
      const limit = IMAGE_FIELDS.has(box.field) ? 1 : OVERLAY_LIMITS.maxBoxesPerField;
      if (count === limit + 1) {
        ctx.addIssue({
          code: "custom",
          message: IMAGE_FIELDS.has(box.field) ? "A pad can have only one box for this image." : `A field can have at most ${OVERLAY_LIMITS.maxBoxesPerField} boxes.`,
          path: ["boxes", i, "field"],
        });
      }
    });
    if (new Set(def.flow.sections).size !== def.flow.sections.length) {
      ctx.addIssue({ code: "custom", message: "A section is listed twice.", path: ["flow", "sections"] });
    }
    if (def.signature.mode === "box" && !def.boxes.some((b) => b.field === "doctor.signature")) {
      ctx.addIssue({ code: "custom", message: "Add a signature box, or print the signature after the prescription.", path: ["signature", "mode"] });
    }
  });

export type OverlayDefinition = z.infer<typeof overlayDefinitionSchema>;
export type OverlayBox = OverlayDefinition["boxes"][number];
export type GeometryIssue = { path: string; message: string };

const EPSILON = 0.05;

/** Placement problems the schema cannot see because they depend on the paper size. */
export function overlayGeometryIssues(def: OverlayDefinition, paperSize: PaperSize): GeometryIssue[] {
  const { widthMm, heightMm } = PAPER[paperSize];
  const band = def.pageNumbers.bandMm;
  const issues: GeometryIssue[] = [];
  def.boxes.forEach((box, i) => {
    if (box.xMm + box.wMm > widthMm + EPSILON || box.yMm + box.hMm > heightMm - band + EPSILON) {
      issues.push({ path: `boxes.${i}`, message: `The "${box.id}" box goes past the edge of the page${band > 0 ? " or into the page-number band" : ""}.` });
    }
  });
  if (def.flow.bottomMm < band) issues.push({ path: "flow.bottomMm", message: "The body region runs into the page-number band." });
  if (heightMm - def.flow.topMm - def.flow.bottomMm < OVERLAY_LIMITS.minFlowHeightMm) {
    issues.push({ path: "flow", message: `The body region is too short: leave at least ${OVERLAY_LIMITS.minFlowHeightMm} mm for the prescription.` });
  }
  if (widthMm - def.flow.leftMm - def.flow.rightMm < OVERLAY_LIMITS.minFlowWidthMm) {
    issues.push({ path: "flow", message: `The body region is too narrow: leave at least ${OVERLAY_LIMITS.minFlowWidthMm} mm.` });
  }
  const maxSpacer = OVERLAY_LIMITS.maxSpacerMm[paperSize];
  if (def.flow.topMm > maxSpacer + EPSILON) {
    issues.push({ path: "flow.topMm", message: `The space above the body is too tall: keep it within ${maxSpacer} mm (about a quarter of the page).` });
  }
  if (def.flow.bottomMm > maxSpacer + EPSILON) {
    issues.push({ path: "flow.bottomMm", message: `The space below the body is too tall: keep it within ${maxSpacer} mm (about a quarter of the page).` });
  }
  return issues;
}

/** The stored definition, or null when it is damaged or does not fit the paper (callers fail closed). Never throws. */
export function parseOverlayDefinition(value: unknown, paperSize: PaperSize): OverlayDefinition | null {
  try {
    const parsed = overlayDefinitionSchema.safeParse(value);
    if (!parsed.success) return null;
    return overlayGeometryIssues(parsed.data, paperSize).length === 0 ? parsed.data : null;
  } catch {
    // A hostile getter or proxy: treat as damaged.
    return null;
  }
}

/** A starting layout: a patient strip under a typical letterhead and the body below it (auto-layout refines it). */
export function defaultOverlayDefinition(paperSize: PaperSize): OverlayDefinition {
  const { widthMm: w, heightMm: h } = PAPER[paperSize];
  const y = tenth(h * 0.18);
  const rowH = paperSize === "A4" ? 7 : 6;
  const font = paperSize === "A4" ? 10 : 8.5;
  const box = (id: string, field: OverlayBox["field"], x: number, width: number, align: OverlayBox["align"]): OverlayBox => ({
    id,
    field,
    xMm: tenth(w * x),
    yMm: y,
    wMm: tenth(w * width),
    hMm: rowH,
    fontPt: font,
    align,
    bold: field === "patient.name",
    repeat: "every_page",
  });
  return {
    v: 1,
    background: { printMode: "always" },
    boxes: [
      box("name", "patient.name", 0.07, 0.4, "left"),
      box("age", "patient.age_gender", 0.48, 0.18, "left"),
      box("date", "visit.date", 0.67, 0.14, "right"),
      box("rx", "visit.rx_no", 0.82, 0.11, "right"),
    ],
    flow: {
      topMm: tenth(y + rowH + 3),
      bottomMm: tenth(h * 0.09),
      leftMm: tenth(w * 0.07),
      rightMm: tenth(w * 0.07),
      bodyStyle: "general",
      sections: [...SECTION_KEYS],
      showRxMark: true,
    },
    signature: { mode: "end_of_content" },
    pageNumbers: { bandMm: 0 },
    printOffsetMm: { x: 0, y: 0 },
  };
}
