import type { BoxFieldKey } from "@/lib/rx-render/fields";
import { OVERLAY_LIMITS, type OverlayBox, type OverlayDefinition } from "@/lib/rx-render/overlay-definition";
import { PAPER } from "@/lib/rx-render/paper";
import type { PaperSize } from "@/lib/rx-render/types";

export const MOVE_STEP_MM = 1;
export const BIG_STEP_MM = 5;

export type EditorState = { definition: OverlayDefinition; paper: PaperSize; selected: string | null; dirty: boolean };

type BoxPatch = Partial<Pick<OverlayBox, "field" | "xMm" | "yMm" | "wMm" | "hMm" | "fontPt" | "align" | "bold" | "repeat">>;
type OptionsPatch = Partial<Pick<OverlayDefinition, "background" | "signature" | "pageNumbers" | "printOffsetMm">>;

export type EditorAction =
  | { type: "select"; id: string | null }
  | { type: "add"; field: BoxFieldKey }
  | { type: "remove"; id: string }
  | { type: "move"; id: string; dxMm: number; dyMm: number }
  | { type: "resize"; id: string; dwMm: number; dhMm: number }
  | { type: "set"; id: string; patch: BoxPatch }
  | { type: "flow"; patch: Partial<OverlayDefinition["flow"]> }
  | { type: "options"; patch: OptionsPatch }
  | { type: "replace"; definition: OverlayDefinition }
  | { type: "saved" };

const tenth = (n: number) => Math.round(n * 10) / 10;
const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, Number.isFinite(n) ? n : min));
const IMAGE_FIELDS: ReadonlySet<string> = new Set(["clinic.logo", "doctor.signature"]);

export function initialEditorState(definition: OverlayDefinition, paper: PaperSize): EditorState {
  return { definition, paper, selected: null, dirty: false };
}

export function nextBoxId(boxes: readonly { id: string }[]): string {
  const used = boxes.map((b) => /^b(\d+)$/.exec(b.id)).filter((m): m is RegExpExecArray => m !== null).map((m) => Number(m[1]));
  return `b${Math.max(0, ...used) + 1}`;
}

/** Why another box for this field cannot be added (the schema's per-field limits), or null. */
export function boxLimitReason(boxes: readonly { field: string }[], field: string): string | null {
  if (boxes.length >= OVERLAY_LIMITS.maxBoxes) return `A pad can have at most ${OVERLAY_LIMITS.maxBoxes} boxes.`;
  const count = boxes.filter((b) => b.field === field).length;
  if (IMAGE_FIELDS.has(field)) return count >= 1 ? "A pad can have only one box for this image." : null;
  return count >= OVERLAY_LIMITS.maxBoxesPerField ? `A field can have at most ${OVERLAY_LIMITS.maxBoxesPerField} boxes.` : null;
}

/** Keeps a box whole on the usable page (above the page-number band) with lengths rounded to 0.1 mm. */
function fit(box: OverlayBox, paper: PaperSize, band: number): OverlayBox {
  const { widthMm: w, heightMm: h } = PAPER[paper];
  const usable = h - band;
  const wMm = tenth(clamp(box.wMm, OVERLAY_LIMITS.minBoxMm, w));
  const hMm = tenth(clamp(box.hMm, OVERLAY_LIMITS.minBoxMm, usable));
  return {
    ...box,
    wMm,
    hMm,
    xMm: tenth(clamp(box.xMm, 0, w - wMm)),
    yMm: tenth(clamp(box.yMm, 0, usable - hMm)),
    fontPt: tenth(clamp(box.fontPt, OVERLAY_LIMITS.minFontPt, OVERLAY_LIMITS.maxFontPt)),
  };
}

function fitFlow(flow: OverlayDefinition["flow"], paper: PaperSize, band: number): OverlayDefinition["flow"] {
  const { widthMm: w, heightMm: h } = PAPER[paper];
  const bottomMm = tenth(clamp(flow.bottomMm, band, h - OVERLAY_LIMITS.minFlowHeightMm));
  const topMm = tenth(clamp(flow.topMm, 0, h - bottomMm - OVERLAY_LIMITS.minFlowHeightMm));
  const leftMm = tenth(clamp(flow.leftMm, 0, w - OVERLAY_LIMITS.minFlowWidthMm));
  const rightMm = tenth(clamp(flow.rightMm, 0, w - leftMm - OVERLAY_LIMITS.minFlowWidthMm));
  return { ...flow, topMm, bottomMm, leftMm, rightMm };
}

/** The schema refuses "signature in a box" without a signature box: fall back to printing it after the prescription. */
function withValidSignature(definition: OverlayDefinition): OverlayDefinition {
  if (definition.signature.mode === "box" && !definition.boxes.some((b) => b.field === "doctor.signature")) {
    return { ...definition, signature: { mode: "end_of_content" } };
  }
  return definition;
}

function mapBox(state: EditorState, id: string, change: (box: OverlayBox) => OverlayBox): EditorState {
  const band = state.definition.pageNumbers.bandMm;
  const boxes = state.definition.boxes.map((box) => (box.id === id ? fit(change(box), state.paper, band) : box));
  return { ...state, definition: withValidSignature({ ...state.definition, boxes }), dirty: true };
}

/**
 * Pure editor state: every change keeps the definition inside overlayDefinitionSchema and on the paper. The spacer rule
 * (override 21a) is deliberately NOT applied here: the editor shows overlayGeometryIssues() so it is the server's rule.
 */
export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  const band = state.definition.pageNumbers.bandMm;
  switch (action.type) {
    case "select":
      return { ...state, selected: action.id };
    case "add": {
      if (boxLimitReason(state.definition.boxes, action.field) !== null) return state;
      const { widthMm, heightMm } = PAPER[state.paper];
      const image = IMAGE_FIELDS.has(action.field);
      const box = fit(
        { id: nextBoxId(state.definition.boxes), field: action.field, xMm: widthMm * 0.35, yMm: heightMm * 0.3, wMm: widthMm * (image ? 0.2 : 0.3), hMm: image ? 15 : 7, fontPt: 10, align: "left", bold: false, repeat: "every_page" },
        state.paper,
        band,
      );
      return { ...state, definition: { ...state.definition, boxes: [...state.definition.boxes, box] }, selected: box.id, dirty: true };
    }
    case "remove":
      return {
        ...state,
        definition: withValidSignature({ ...state.definition, boxes: state.definition.boxes.filter((b) => b.id !== action.id) }),
        selected: state.selected === action.id ? null : state.selected,
        dirty: true,
      };
    case "move":
      return mapBox(state, action.id, (b) => ({ ...b, xMm: b.xMm + action.dxMm, yMm: b.yMm + action.dyMm }));
    case "resize":
      return mapBox(state, action.id, (b) => ({ ...b, wMm: b.wMm + action.dwMm, hMm: b.hMm + action.dhMm }));
    case "set": {
      let patch = action.patch;
      const target = action.patch.field;
      if (target !== undefined && target !== state.definition.boxes.find((b) => b.id === action.id)?.field) {
        // Changing a box to a field that is at its limit would make the pad invalid: keep the old field.
        if (boxLimitReason(state.definition.boxes.filter((b) => b.id !== action.id), target) !== null) {
          patch = Object.fromEntries(Object.entries(patch).filter(([key]) => key !== "field")) as BoxPatch;
        }
      }
      return mapBox(state, action.id, (b) => ({ ...b, ...patch }));
    }
    case "flow":
      return { ...state, definition: { ...state.definition, flow: fitFlow({ ...state.definition.flow, ...action.patch }, state.paper, band) }, dirty: true };
    case "options": {
      const definition = { ...state.definition, ...action.patch };
      const nextBand = definition.pageNumbers.bandMm;
      return {
        ...state,
        definition: withValidSignature({ ...definition, boxes: definition.boxes.map((b) => fit(b, state.paper, nextBand)), flow: fitFlow(definition.flow, state.paper, nextBand) }),
        dirty: true,
      };
    }
    case "replace":
      return { ...state, definition: action.definition, dirty: false };
    case "saved":
      return { ...state, dirty: false };
  }
}
