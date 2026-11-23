// @vitest-environment node
import { describe, expect, it } from "vitest";
import { BACKGROUND_LIMITS, IMAGE_LIMITS } from "@/lib/domain/image";
import { MAX_DOCUMENT_CHARS } from "@/lib/rx-render/self-contained";
import type { OverlayDefinition } from "@/lib/rx-render/overlay-definition";
import { loadFontCss } from "@/server/rx-render/fonts";
import {
  EMBEDDED_FONT_CHARS,
  MARKUP_MARGIN_CHARS,
  base64Chars,
  estimateOverlayDocumentChars,
  overlayPublishIssues,
} from "@/lib/templates/publish-rules";
import { MINIMAL_OVERLAY_DEFINITION } from "../fixtures/overlay-definitions";

const def = (): OverlayDefinition => structuredClone(MINIMAL_OVERLAY_DEFINITION) as unknown as OverlayDefinition;
const codes = (d: OverlayDefinition, identity: Parameters<typeof overlayPublishIssues>[2], assets?: Parameters<typeof overlayPublishIssues>[3]) =>
  overlayPublishIssues(d, "A4", identity, assets).map((i) => i.code);

describe("overlayPublishIssues: signature counted once", () => {
  it("refuses the signature after the prescription together with a signature box", () => {
    const d = def();
    d.boxes.push({ id: "sig", field: "doctor.signature", xMm: 140, yMm: 250, wMm: 40, hMm: 15, fontPt: 10, align: "left", bold: false, repeat: "every_page" } as OverlayDefinition["boxes"][number]);
    expect(codes(d, { kind: "dynamic" })).toEqual(["signature_twice"]);
    expect(codes({ ...d, signature: { mode: "box" } }, { kind: "dynamic" })).not.toContain("signature_twice");
  });
});

describe("overlayPublishIssues", () => {
  it("passes the minimal dynamic definition (the signature block prints the doctor's name and registration)", () => {
    expect(codes(def(), { kind: "dynamic" })).toEqual([]);
  });

  it("needs the patient's name, the date and the medicines", () => {
    const d = { ...def(), boxes: [], flow: { ...def().flow, sections: ["advice" as const] } };
    expect(codes(d, { kind: "dynamic" })).toEqual(["missing_patient_name", "missing_date", "missing_medicines"]);
  });

  it("needs the doctor's name and registration on a dynamic pad that prints the signature in a box", () => {
    const sig = { id: "sig", field: "doctor.signature" as const, xMm: 140, yMm: 250, wMm: 50, hMm: 15, fontPt: 10, align: "center" as const, bold: false, repeat: "every_page" as const };
    const d = { ...def(), signature: { mode: "box" as const }, boxes: [...def().boxes, sig] };
    expect(codes(d, { kind: "dynamic" })).toEqual(["doctor_identity"]);
    const named = { ...d, boxes: [...d.boxes, { ...sig, id: "dn", field: "doctor.name" as const, yMm: 266, hMm: 6 }, { ...sig, id: "dr", field: "doctor.reg_no" as const, yMm: 273, hMm: 6 }] };
    expect(codes(named, { kind: "dynamic" })).toEqual([]);
  });

  it("needs a doctor and an explicit confirmation for a bound pad", () => {
    expect(codes(def(), { kind: "bound", doctorId: null, confirmed: false })).toEqual(["bound_doctor", "bound_confirmation"]);
    expect(codes(def(), { kind: "bound", doctorId: "019a0000-0000-7000-8000-000000000002", confirmed: true })).toEqual([]);
  });

  it("reports geometry problems first", () => {
    expect(overlayPublishIssues(def(), "A5", { kind: "dynamic" })[0].code).toBe("geometry");
  });

  it("refuses a header gap over 24% of the page at publish", () => {
    const d = { ...def(), flow: { ...def().flow, topMm: 72 } };
    expect(codes(d, { kind: "dynamic" })).toEqual(["geometry"]);
  });

  it("refuses overlapping boxes but allows touching ones", () => {
    const [a] = def().boxes;
    const overlapping = { ...def(), boxes: [a, { ...a, id: "b3", xMm: a.xMm + 10, yMm: a.yMm + 2 }, def().boxes[1]] };
    expect(codes(overlapping, { kind: "dynamic" })).toEqual(["box_overlap"]);
    const touching = { ...def(), boxes: [a, { ...a, id: "b3", yMm: a.yMm + a.hMm }, def().boxes[1]] };
    expect(codes(touching, { kind: "dynamic" })).toEqual([]);
  });
});

describe("document size budget (override 3)", () => {
  it("computes base64 length exactly", () => {
    expect(base64Chars(0)).toBe(0);
    expect(base64Chars(1)).toBe(4);
    expect(base64Chars(3)).toBe(4);
    expect(base64Chars(512 * 1024)).toBe(699_052);
    expect(base64Chars(1000)).toBe(Buffer.alloc(1000).toString("base64").length);
  });

  it("the font constant covers the real inlined font stylesheet and stays a tight bound", () => {
    const real = loadFontCss().length;
    expect(real).toBeLessThanOrEqual(EMBEDDED_FONT_CHARS);
    expect(EMBEDDED_FONT_CHARS - real).toBeLessThan(120_000);
  });

  it("the largest allowed assets fit under MAX_DOCUMENT_CHARS with the markup margin", () => {
    const worst = estimateOverlayDocumentChars(BACKGROUND_LIMITS.maxBytes);
    expect(worst).toBe(base64Chars(BACKGROUND_LIMITS.maxBytes) + 2 * base64Chars(IMAGE_LIMITS.maxBytes) + EMBEDDED_FONT_CHARS + MARKUP_MARGIN_CHARS);
    expect(MARKUP_MARGIN_CHARS).toBe(300 * 1024);
    expect(worst).toBeLessThan(MAX_DOCUMENT_CHARS);
    expect(codes(def(), { kind: "dynamic" }, { backgroundBytes: BACKGROUND_LIMITS.maxBytes })).toEqual([]);
  });

  it("refuses a background that would push the document over the cap", () => {
    const tooBig = 2 * 1024 * 1024;
    expect(estimateOverlayDocumentChars(tooBig)).toBeGreaterThan(MAX_DOCUMENT_CHARS);
    const issues = overlayPublishIssues(def(), "A4", { kind: "dynamic" }, { backgroundBytes: tooBig });
    expect(issues.map((i) => i.code)).toEqual(["document_too_large"]);
  });

  it("refuses a nonsense background size", () => {
    expect(codes(def(), { kind: "dynamic" }, { backgroundBytes: Number.NaN })).toEqual(["document_too_large"]);
    expect(codes(def(), { kind: "dynamic" }, { backgroundBytes: -1 })).toEqual(["document_too_large"]);
  });
});
