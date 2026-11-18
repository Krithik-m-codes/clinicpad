import { describe, expect, it } from "vitest";
import { renderAlignmentCheck } from "@/lib/rx-render/overlay-alignment";
import { renderOverlay } from "@/lib/rx-render/overlay";
import { checkSelfContained } from "@/lib/rx-render/self-contained";
import { overlayDefinition, overlayDocument, overlayInput } from "../fixtures/overlay-documents";

const parse = (markup: string) => new DOMParser().parseFromString(markup, "text/html");
const css = (markup: string) => parse(markup).querySelector("style")?.textContent ?? "";

describe("renderAlignmentCheck", () => {
  it("outlines every box and the body region with fixed labels, without the background, and is self-contained", () => {
    const html = renderAlignmentCheck(overlayDefinition(), "A4", "");
    expect(checkSelfContained(html)).toEqual({ ok: true });
    const page = parse(html);
    expect(page.querySelectorAll(".box")).toHaveLength(2);
    expect(page.querySelector(".box-0")?.textContent).toBe("Patient's name");
    expect(page.querySelector(".flow-outline")).not.toBeNull();
    expect(page.querySelector(".bg")).toBeNull();
    expect(page.querySelector("img")).toBeNull();
    expect(page.body.textContent).toContain("hold it against the light");
    expect(page.body.textContent).toContain("Actual size");
  });

  it("applies the printer offset, as printing does", () => {
    const html = renderAlignmentCheck(overlayDefinition({ printOffsetMm: { x: 2, y: -1.5 } }), "A4", "");
    expect(css(html)).toContain(".box-0{left:22mm;top:50.5mm;");
  });

  it("moves the body outline by the same offset and formats its numbers like every other length", () => {
    const def = overlayDefinition({ printOffsetMm: { x: 0.1, y: 0.2 } });
    const text = css(renderAlignmentCheck(def, "A4", ""));
    const outline = text.split("\n").find((line) => line.startsWith(".flow-outline")) ?? "";
    expect(outline).not.toBe("");
    // Every length goes through the shared formatter: at most one decimal, never exponent or float noise.
    for (const match of outline.matchAll(/(-?[\d.e+-]+)mm/g)) expect(match[1]).toMatch(/^-?\d+(\.\d)?$/);
    expect(outline).toContain(`top:${def.flow.topMm + 0.2}mm`.replace(/(\.\d)\d+/, "$1"));
  });

  it("uses the same effective spacer limit as printing, offset included", () => {
    const def = overlayDefinition({ printOffsetMm: { x: 0, y: 10 } });
    const aligned = css(renderAlignmentCheck(def, "A4", ""));
    const printed = css(renderOverlay(overlayDocument(), { logo: null, signature: null, fontCss: "" }, overlayInput(def), { target: "print", sample: false }).html);
    const pick = (text: string, name: string) => text.split("\n").find((l) => l.startsWith(name));
    expect(pick(aligned, ".flow-top")).toBe(pick(printed, ".flow-top"));
    expect(pick(aligned, ".flow-bottom")).toBe(pick(printed, ".flow-bottom"));
  });
});
