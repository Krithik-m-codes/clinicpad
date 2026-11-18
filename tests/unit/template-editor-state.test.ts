import { describe, expect, it } from "vitest";
import { BOX_FIELD_KEYS } from "@/lib/rx-render/fields";
import { overlayDefinitionSchema, overlayGeometryIssues } from "@/lib/rx-render/overlay-definition";
import { boxLimitReason, editorReducer, initialEditorState, nextBoxId } from "@/lib/templates/editor-state";
import { MINIMAL_OVERLAY_DEFINITION } from "../fixtures/overlay-definitions";

const start = () => initialEditorState(overlayDefinitionSchema.parse(structuredClone(MINIMAL_OVERLAY_DEFINITION)), "A4");

describe("editorReducer", () => {
  it("moves a box by millimetres and keeps it on the page", () => {
    let s = editorReducer(start(), { type: "move", id: "b1", dxMm: 5.04, dyMm: -1 });
    expect(s.definition.boxes[0]).toMatchObject({ xMm: 25, yMm: 51 });
    expect(s.dirty).toBe(true);
    s = editorReducer(s, { type: "move", id: "b1", dxMm: 500, dyMm: 500 });
    expect(s.definition.boxes[0]).toMatchObject({ xMm: 120, yMm: 290 });
    s = editorReducer(s, { type: "move", id: "b1", dxMm: -999, dyMm: -999 });
    expect(s.definition.boxes[0]).toMatchObject({ xMm: 0, yMm: 0 });
  });

  it("resizes within the page and never below 3 mm", () => {
    let s = editorReducer(start(), { type: "resize", id: "b2", dwMm: -100, dhMm: -100 });
    expect(s.definition.boxes[1]).toMatchObject({ wMm: 3, hMm: 3 });
    s = editorReducer(s, { type: "resize", id: "b2", dwMm: 500, dhMm: 0 });
    expect(s.definition.boxes[1].xMm + s.definition.boxes[1].wMm).toBe(210);
  });

  it("keeps boxes out of the page-number band", () => {
    const banded = editorReducer(start(), { type: "options", patch: { pageNumbers: { bandMm: 10 } } });
    const s = editorReducer(banded, { type: "move", id: "b1", dxMm: 0, dyMm: 999 });
    expect(s.definition.boxes[0].yMm + s.definition.boxes[0].hMm).toBe(287);
  });

  it("adds boxes with unique ids up to 30, removes them, and clears the selection", () => {
    let s = start();
    const fields = BOX_FIELD_KEYS.filter((k) => k !== "clinic.logo" && k !== "doctor.signature");
    for (let i = 0; i < 40; i += 1) s = editorReducer(s, { type: "add", field: fields[i % fields.length] });
    expect(s.definition.boxes).toHaveLength(30);
    expect(new Set(s.definition.boxes.map((b) => b.id)).size).toBe(30);
    expect(overlayDefinitionSchema.safeParse(s.definition).success).toBe(true);
    s = editorReducer(s, { type: "select", id: "b1" });
    s = editorReducer(s, { type: "remove", id: "b1" });
    expect(s.selected).toBeNull();
    expect(s.definition.boxes.some((b) => b.id === "b1")).toBe(false);
  });

  it("allows 3 boxes per text field and one per image field (overrides 3 and 16)", () => {
    let s = start();
    for (let i = 0; i < 5; i += 1) s = editorReducer(s, { type: "add", field: "doctor.name" });
    expect(s.definition.boxes.filter((b) => b.field === "doctor.name")).toHaveLength(3);
    for (let i = 0; i < 3; i += 1) s = editorReducer(s, { type: "add", field: "clinic.logo" });
    s = editorReducer(s, { type: "add", field: "doctor.signature" });
    s = editorReducer(s, { type: "add", field: "doctor.signature" });
    expect(s.definition.boxes.filter((b) => b.field === "clinic.logo")).toHaveLength(1);
    expect(s.definition.boxes.filter((b) => b.field === "doctor.signature")).toHaveLength(1);
    expect(overlayDefinitionSchema.safeParse(s.definition).success).toBe(true);
    expect(boxLimitReason(s.definition.boxes, "clinic.logo")).toMatch(/only one/i);
    expect(boxLimitReason(s.definition.boxes, "doctor.name")).toMatch(/3/);
    expect(boxLimitReason(s.definition.boxes, "visit.type")).toBeNull();
  });

  it("refuses a field change that would break the per-field limit", () => {
    let s = start();
    s = editorReducer(s, { type: "add", field: "clinic.logo" });
    const logo = s.definition.boxes.find((b) => b.field === "clinic.logo")?.id ?? "";
    s = editorReducer(s, { type: "set", id: "b1", patch: { field: "clinic.logo", fontPt: 12 } });
    expect(s.definition.boxes[0]).toMatchObject({ field: "patient.name", fontPt: 12 });
    expect(logo).not.toBe("");
    expect(overlayDefinitionSchema.safeParse(s.definition).success).toBe(true);
  });

  it("falls back to the after-the-prescription signature when the signature box goes away", () => {
    let s = editorReducer(start(), { type: "add", field: "doctor.signature" });
    const id = s.definition.boxes[2].id;
    s = editorReducer(s, { type: "options", patch: { signature: { mode: "box" } } });
    expect(overlayDefinitionSchema.safeParse(s.definition).success).toBe(true);
    const removed = editorReducer(s, { type: "remove", id });
    expect(removed.definition.signature.mode).toBe("end_of_content");
    const changed = editorReducer(s, { type: "set", id, patch: { field: "doctor.name" } });
    expect(changed.definition.signature.mode).toBe("end_of_content");
    expect(overlayDefinitionSchema.safeParse(changed.definition).success).toBe(true);
  });

  it("changes a box's field and font within the limits", () => {
    const s = editorReducer(start(), { type: "set", id: "b1", patch: { field: "patient.age_gender", fontPt: 40, bold: false } });
    expect(s.definition.boxes[0]).toMatchObject({ field: "patient.age_gender", fontPt: 24, bold: false });
  });

  it("keeps the body region at least 40 mm tall and 60 mm wide", () => {
    const s = editorReducer(start(), { type: "flow", patch: { topMm: 280, leftMm: 200 } });
    expect(297 - s.definition.flow.topMm - s.definition.flow.bottomMm).toBeGreaterThanOrEqual(40);
    expect(210 - s.definition.flow.leftMm - s.definition.flow.rightMm).toBeGreaterThanOrEqual(60);
  });

  it("leaves the spacer rule to overlayGeometryIssues so the editor shows the server's rule", () => {
    const s = editorReducer(start(), { type: "flow", patch: { topMm: 100 } });
    expect(s.definition.flow.topMm).toBe(100);
    expect(overlayGeometryIssues(s.definition, "A4").some((i) => i.path === "flow.topMm")).toBe(true);
  });

  it("produces definitions the schema accepts, and marks a save", () => {
    let s = editorReducer(start(), { type: "add", field: "clinic.logo" });
    s = editorReducer(s, { type: "move", id: s.definition.boxes[2].id, dxMm: 0.33, dyMm: 0.77 });
    expect(overlayDefinitionSchema.parse(s.definition)).toEqual(s.definition);
    expect(editorReducer(s, { type: "saved" }).dirty).toBe(false);
  });

  it("picks the next free id", () => {
    expect(nextBoxId([{ id: "b1" }, { id: "b3" }, { id: "name" }])).toBe("b4");
  });
});
