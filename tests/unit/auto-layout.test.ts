import { describe, expect, it } from "vitest";
import { defaultOverlayDefinition, overlayGeometryIssues } from "@/lib/rx-render/overlay-definition";
import { autoLayout } from "@/lib/templates/auto-layout";

const page = (ink: (i: number) => boolean, strips = 100) => Array.from({ length: strips }, (_, i) => (ink(i) ? 0.3 : 0.01));

describe("autoLayout", () => {
  it("places the patient strip under the letterhead and the body above the footer", () => {
    const def = autoLayout("A4", page((i) => i < 15 || i >= 92));
    expect(def.boxes.every((b) => b.yMm === 47.6)).toBe(true);
    expect(def.flow.topMm).toBe(57.6);
    expect(def.flow.bottomMm).toBe(26.8);
    expect(overlayGeometryIssues(def, "A4")).toEqual([]);
  });

  it("falls back to the default layout when the letterhead is so tall that the repeating spacer would exceed the limit (override 16a)", () => {
    expect(autoLayout("A4", page((i) => i < 20))).toEqual(defaultOverlayDefinition("A4"));
  });

  it("falls back to the default layout on a blank or unreadable page", () => {
    expect(autoLayout("A5", page(() => false))).toEqual(defaultOverlayDefinition("A5"));
    expect(autoLayout("A5", [])).toEqual(defaultOverlayDefinition("A5"));
  });

  it("never lets a fully printed page squeeze the body below the minimum", () => {
    for (const paper of ["A4", "A5"] as const) expect(overlayGeometryIssues(autoLayout(paper, page(() => true)), paper)).toEqual([]);
  });

  it("ignores NaN and Infinity strips instead of producing NaN geometry (the last letterhead strip is unusable, so the strip moves up)", () => {
    const withBad: number[] = page((i) => i < 15 || i >= 92);
    withBad[14] = Number.NaN;
    withBad[13] = Number.POSITIVE_INFINITY;
    withBad[12] = Number.NaN;
    const def = autoLayout("A4", withBad);
    expect(overlayGeometryIssues(def, "A4")).toEqual([]);
    expect(def.boxes.every((b) => Number.isFinite(b.yMm))).toBe(true);
    expect(def.boxes[0].yMm).toBe(38.6); // last usable inked strip is 11: (11 + 1) * 2.97 + 3
    expect(Number.isFinite(def.flow.topMm) && Number.isFinite(def.flow.bottomMm)).toBe(true);
  });
});
