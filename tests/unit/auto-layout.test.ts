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

  it("ignores NaN and out-of-range strips instead of producing NaN geometry", () => {
    const def = autoLayout("A4", page((i) => i < 20).map((v, i) => (i === 50 ? Number.NaN : v)));
    expect(overlayGeometryIssues(def, "A4")).toEqual([]);
    expect(def.boxes.every((b) => Number.isFinite(b.yMm))).toBe(true);
  });
});
