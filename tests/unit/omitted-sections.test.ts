// @vitest-environment node
import { describe, expect, it } from "vitest";
import { omittedSections, sectionsWithContent, unprintedContent } from "@/lib/rx-render/omitted";
import { overlayDefinitionSchema, type OverlayDefinition } from "@/lib/rx-render/overlay-definition";
import { sampleDocument } from "@/lib/rx-render/samples";
import { snapshot } from "../fixtures/rx-documents";
import { MINIMAL_OVERLAY_DEFINITION } from "../fixtures/overlay-definitions";

const def = (sections: string[], extraBoxes: Array<{ id: string; field: string }> = []): OverlayDefinition => {
  const base = structuredClone(MINIMAL_OVERLAY_DEFINITION) as unknown as Record<string, unknown> & { flow: Record<string, unknown>; boxes: unknown[] };
  base.flow.sections = sections;
  extraBoxes.forEach((b, i) => base.boxes.push({ ...b, xMm: 20, yMm: 100 + i * 10, wMm: 60, hMm: 7, fontPt: 10, align: "left", bold: false, repeat: "every_page" }));
  return overlayDefinitionSchema.parse(base);
};
const ALL = ["vitals", "chiefComplaint", "complaints", "medicalHistory", "drugHistory", "examination", "diagnosis", "medicines", "investigations", "advice", "followUp"];

describe("omittedSections", () => {
  it("is empty when every section is in the flow", () => expect(omittedSections(def(ALL))).toEqual([]));
  it("lists what a designer unticks (Advice), in catalogue order", () => {
    expect(omittedSections(def(ALL.filter((k) => k !== "advice" && k !== "vitals")))).toEqual(["vitals", "advice"]);
  });
  it("does not count a section that an equivalent box prints", () => {
    expect(omittedSections(def(ALL.filter((k) => k !== "advice"), [{ id: "adv", field: "advice" }]))).toEqual([]);
    expect(omittedSections(def(ALL.filter((k) => k !== "vitals"), [{ id: "bp", field: "vitals.bp" }]))).toEqual([]);
  });
  it("investigations print only in the flow", () => {
    expect(omittedSections(def(ALL.filter((k) => k !== "investigations")))).toEqual(["investigations"]);
  });
});

describe("unprintedContent", () => {
  it("reports omitted sections that the document has content in, and none for empty ones", () => {
    const doc = sampleDocument("short", snapshot());
    const withContent = sectionsWithContent(doc);
    expect(withContent).toContain("medicines");
    const d = def(ALL.filter((k) => k !== "advice" && k !== "followUp"));
    const unprinted = unprintedContent({ ...doc, visit: { ...doc.visit, advice: "Rest", followUpDate: null, followUpReason: null } }, d);
    expect(unprinted).toEqual(["advice"]);
    expect(unprintedContent({ ...doc, visit: { ...doc.visit, advice: "  ", followUpDate: null, followUpReason: null } }, d)).toEqual([]);
  });
});
