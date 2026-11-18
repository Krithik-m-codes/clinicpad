import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "@/lib/rx-render/canonical-json";
import {
  defaultOverlayDefinition,
  OVERLAY_LIMITS,
  overlayDefinitionSchema,
  overlayGeometryIssues,
  parseOverlayDefinition,
  type OverlayDefinition,
} from "@/lib/rx-render/overlay-definition";
import { MINIMAL_OVERLAY_DEFINITION } from "../fixtures/overlay-definitions";

const base = (): OverlayDefinition => structuredClone(MINIMAL_OVERLAY_DEFINITION) as unknown as OverlayDefinition;
const withBox = (patch: Record<string, unknown>) => ({ ...base(), boxes: [{ ...base().boxes[0], ...patch }] });
const imageBox = (id: string, field: "clinic.logo" | "doctor.signature", yMm = 10) => ({
  ...base().boxes[0], id, field, yMm, xMm: 150, wMm: 40, hMm: 20,
});

describe("overlayDefinitionSchema", () => {
  it("accepts the test helpers' minimal definition on A4 (keeps the two in step)", () => {
    expect(parseOverlayDefinition(MINIMAL_OVERLAY_DEFINITION, "A4")).not.toBeNull();
  });

  it("rounds every length to 0.1 mm, idempotently", () => {
    const parsed = overlayDefinitionSchema.parse(withBox({ xMm: 20.04, yMm: 52.06, fontPt: 10.26 }));
    expect(parsed.boxes[0]).toMatchObject({ xMm: 20, yMm: 52.1, fontPt: 10.3 });
    expect(overlayDefinitionSchema.parse(parsed)).toEqual(parsed);
  });

  it.each([
    ["the patient's phone", withBox({ field: "patient.phone" })],
    ["a QR code", withBox({ field: "qr" })],
    ["a list field in a box", withBox({ field: "medicines" })],
    ["a prototype name as a field", withBox({ field: "constructor" })],
    ["NaN", withBox({ xMm: Number.NaN })],
    ["Infinity", withBox({ wMm: Number.POSITIVE_INFINITY })],
    ["-Infinity", withBox({ yMm: Number.NEGATIVE_INFINITY })],
    ["a numeric string", withBox({ xMm: "20" })],
    ["a negative position", withBox({ xMm: -1 })],
    ["a box 300 mm wide", withBox({ wMm: 300 })],
    ["a 2 mm box", withBox({ hMm: 2 })],
    ["5 pt text", withBox({ fontPt: 5 })],
    ["25 pt text", withBox({ fontPt: 25 })],
    ["an id with a quote", withBox({ id: 'b1" onload="x' })],
    ["an upper-case id", withBox({ id: "B1" })],
    ["an id with a NUL", withBox({ id: "b\u0000" })],
    ["an id with a bidi override", withBox({ id: "b\u202e1" })],
    ["a trailing newline in an id", withBox({ id: "b1\n" })],
    ["an unknown alignment", withBox({ align: "justify" })],
    ["31 boxes", { ...base(), boxes: Array.from({ length: 31 }, (_, i) => ({ ...base().boxes[0], id: `b${i}` })) }],
    ["two boxes with one id", { ...base(), boxes: [base().boxes[0], base().boxes[0]] }],
    ["an unknown section", { ...base(), flow: { ...base().flow, sections: ["medicines", "billing"] } }],
    ["a section twice", { ...base(), flow: { ...base().flow, sections: ["medicines", "medicines"] } }],
    ["no sections", { ...base(), flow: { ...base().flow, sections: [] } }],
    ["a 4 mm page-number band", { ...base(), pageNumbers: { bandMm: 4 } }],
    ["a 13 mm page-number band", { ...base(), pageNumbers: { bandMm: 13 } }],
    ["an 11 mm printer offset", { ...base(), printOffsetMm: { x: 11, y: 0 } }],
    ["a signature box mode without a signature box", { ...base(), signature: { mode: "box" } }],
    ["version 2", { ...base(), v: 2 }],
    ["an array instead of an object", []],
    ["null", null],
    ["two logo boxes", { ...base(), boxes: [imageBox("l1", "clinic.logo"), imageBox("l2", "clinic.logo", 40)] }],
    ["two signature boxes", { ...base(), signature: { mode: "box" }, boxes: [imageBox("s1", "doctor.signature"), imageBox("s2", "doctor.signature", 40)] }],
    ["one text field too many times", {
      ...base(),
      boxes: Array.from({ length: OVERLAY_LIMITS.maxBoxesPerField + 1 }, (_, i) => ({ ...base().boxes[0], id: `n${i}`, yMm: 10 + i * 8 })),
    }],
  ])("refuses %s", (_label, value) => {
    expect(overlayDefinitionSchema.safeParse(value).success).toBe(false);
  });

  it("accepts one logo box and one signature box", () => {
    const def = { ...base(), signature: { mode: "box" }, boxes: [imageBox("l1", "clinic.logo"), imageBox("s1", "doctor.signature", 40)] };
    expect(overlayDefinitionSchema.safeParse(def).success).toBe(true);
  });

  it("drops unknown keys instead of storing them", () => {
    const parsed = overlayDefinitionSchema.parse({ ...base(), script: "<script>", boxes: [{ ...base().boxes[0], style: "x" }] });
    expect(JSON.stringify(parsed)).not.toContain("script");
    expect(JSON.stringify(parsed)).not.toContain("style");
  });
});

describe("hostile input", () => {
  it("does not pollute prototypes or store __proto__/constructor keys", () => {
    const hostile = JSON.parse(
      JSON.stringify(base()).replace(
        '"v":1',
        '"v":1,"__proto__":{"polluted":"yes"},"constructor":{"prototype":{"polluted":"yes"}}',
      ),
    ) as unknown;
    expect(Object.hasOwn(hostile as object, "__proto__")).toBe(true);
    const parsed = parseOverlayDefinition(hostile, "A4");
    expect(parsed).not.toBeNull();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.hasOwn(parsed as object, "__proto__")).toBe(false);
    expect(canonicalJson(parsed)).not.toContain("polluted");
  });

  it("refuses a huge boxes array without walking it", () => {
    const huge = { ...base(), boxes: new Array(2_000_000).fill(base().boxes[0]) };
    const started = Date.now();
    expect(parseOverlayDefinition(huge, "A4")).toBeNull();
    expect(Date.now() - started).toBeLessThan(500);
    const sections = { ...base(), flow: { ...base().flow, sections: new Array(2_000_000).fill("medicines") } };
    expect(parseOverlayDefinition(sections, "A4")).toBeNull();
  });

  it("refuses deeply nested values without throwing", () => {
    let deep: unknown = [];
    for (let i = 0; i < 100_000; i++) deep = [deep];
    expect(parseOverlayDefinition({ ...base(), boxes: deep }, "A4")).toBeNull();
    expect(parseOverlayDefinition({ ...base(), background: { printMode: deep } }, "A4")).toBeNull();
    expect(parseOverlayDefinition(deep, "A4")).toBeNull();
  });

  it("does not walk unknown keys and returns null (never throws) for a getter that throws", () => {
    const cyclic: Record<string, unknown> = { ...base() };
    cyclic.self = cyclic;
    expect(parseOverlayDefinition(cyclic, "A4")).not.toBeNull();
    const throwing = { ...base() };
    Object.defineProperty(throwing, "boxes", { get() { throw new Error("boom"); }, enumerable: true });
    expect(parseOverlayDefinition(throwing, "A4")).toBeNull();
  });

  it("never throws, and every accepted definition fits the page, for random hostile numbers", () => {
    let seed = 20261118;
    const rand = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    const nasty = [Number.NaN, Infinity, -Infinity, -0, 0, -1, 1e308, 5e-324, 1e-9, 209.96, 296.94, 300, 12.34567, "7", null, undefined];
    const sane = () => 5 + rand() * 60;
    const pick = () => (rand() < 0.15 ? nasty[Math.floor(rand() * nasty.length)] : rand() < 0.1 ? rand() * 320 - 10 : sane());
    let accepted = 0;
    for (let i = 0; i < 3000; i++) {
      const value = {
        ...base(),
        boxes: [{ ...base().boxes[0], xMm: pick(), yMm: pick(), wMm: pick(), hMm: pick(), fontPt: pick() }],
        flow: { ...base().flow, topMm: pick(), bottomMm: pick(), leftMm: pick(), rightMm: pick() },
        pageNumbers: { bandMm: rand() < 0.15 ? pick() : rand() < 0.5 ? 0 : 5 + rand() * 7 },
        printOffsetMm: { x: rand() < 0.15 ? pick() : rand() * 6 - 3, y: rand() < 0.15 ? pick() : rand() * 6 - 3 },
      };
      const paper = rand() < 0.5 ? "A4" : "A5";
      const parsed = parseOverlayDefinition(value, paper);
      if (!parsed) continue;
      accepted += 1;
      const w = paper === "A4" ? 210 : 148;
      const h = paper === "A4" ? 297 : 210;
      for (const b of parsed.boxes) {
        expect(Number.isFinite(b.xMm + b.yMm + b.wMm + b.hMm + b.fontPt)).toBe(true);
        expect(b.xMm + b.wMm).toBeLessThanOrEqual(w + 0.06);
        expect(b.yMm + b.hMm).toBeLessThanOrEqual(h + 0.06);
      }
      expect(parseOverlayDefinition(parsed, paper)).toEqual(parsed);
    }
    expect(accepted).toBeGreaterThan(0);
  });
});

describe("overlayGeometryIssues", () => {
  it("refuses boxes past the page edge (the A4 definition on A5: the date box ends at 190 mm on a 148 mm page)", () => {
    const paths = overlayGeometryIssues(base(), "A5").map((i) => i.path);
    expect(paths[0]).toBe("boxes.1"); // the A4 header gap (64 mm) is also over A5's 50 mm spacer limit
    expect(paths).toEqual(["boxes.1", "flow.topMm"]);
    expect(parseOverlayDefinition(MINIMAL_OVERLAY_DEFINITION, "A5")).toBeNull();
  });

  it("refuses a body region that is too short, too narrow, or inside the page-number band", () => {
    expect(overlayGeometryIssues({ ...base(), flow: { ...base().flow, topMm: 200, bottomMm: 60 } }, "A4")[0].path).toBe("flow");
    expect(overlayGeometryIssues({ ...base(), flow: { ...base().flow, leftMm: 80, rightMm: 80 } }, "A4")[0].path).toBe("flow");
    expect(overlayGeometryIssues({ ...base(), pageNumbers: { bandMm: 10 }, flow: { ...base().flow, bottomMm: 8 } }, "A4")[0].path).toBe("flow.bottomMm");
    const lowBox = { ...base(), pageNumbers: { bandMm: 10 }, boxes: [{ ...base().boxes[0], yMm: 285, hMm: 7 }] };
    expect(overlayGeometryIssues(lowBox, "A4")[0].path).toBe("boxes.0");
  });

  it("refuses repeating header and footer gaps over 24% of the paper height (override 16a)", () => {
    expect(OVERLAY_LIMITS.maxSpacerMm).toEqual({ A4: 71, A5: 50 });
    const ok = { ...base(), flow: { ...base().flow, topMm: 71, bottomMm: 71 } };
    expect(overlayGeometryIssues(ok, "A4")).toEqual([]);
    const tallTop = { ...base(), flow: { ...base().flow, topMm: 71.1 } };
    expect(overlayGeometryIssues(tallTop, "A4").map((i) => i.path)).toEqual(["flow.topMm"]);
    const tallBottom = { ...base(), flow: { ...base().flow, bottomMm: 71.1 } };
    expect(overlayGeometryIssues(tallBottom, "A4").map((i) => i.path)).toEqual(["flow.bottomMm"]);
    const a5 = { ...base(), boxes: [{ ...base().boxes[0], wMm: 60 }], flow: { ...base().flow, topMm: 50.1, bottomMm: 50, leftMm: 10, rightMm: 10 } };
    expect(overlayGeometryIssues(a5, "A5").map((i) => i.path)).toEqual(["flow.topMm"]);
  });
});

describe("v1 is frozen", () => {
  it("pins the content hash of the minimal definition (sha256 of canonicalJson as stored)", () => {
    const stored = overlayDefinitionSchema.parse(MINIMAL_OVERLAY_DEFINITION);
    expect(canonicalJson(stored)).toBe(canonicalJson(MINIMAL_OVERLAY_DEFINITION));
    const hash = createHash("sha256").update(canonicalJson(stored)).digest("hex");
    expect(hash).toBe("fdd15d86a081507df265f9916a95b96099c581839f3ba60e242a2c264fab1b30");
  });
});

describe("defaultOverlayDefinition", () => {
  it.each(["A4", "A5"] as const)("is valid and fits %s", (paper) => {
    const def = defaultOverlayDefinition(paper);
    expect(overlayDefinitionSchema.parse(def)).toEqual(def);
    expect(overlayGeometryIssues(def, paper)).toEqual([]);
    expect(def.boxes.map((b) => b.field)).toEqual(["patient.name", "patient.age_gender", "visit.date", "visit.rx_no"]);
  });
});
