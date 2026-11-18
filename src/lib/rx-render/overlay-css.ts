import type { OverlayDefinition } from "./overlay-definition";
import type { PaperSpec } from "./types";

const ALIGN = { left: "left", center: "center", right: "right" } as const;

/** A validated length as CSS text. A non-finite number cannot come from a parsed definition: it is a bug, so it throws. */
function n(value: number): string {
  if (!Number.isFinite(value)) throw new Error("overlay css: a length is not a finite number");
  const rounded = Math.round(value * 10) / 10;
  return String(rounded === 0 ? 0 : rounded);
}

/**
 * Positions for one overlay pad, built ONLY from numbers of a definition that overlayDefinitionSchema accepted and from
 * fixed words (spec section 6.2): no strings from the definition, no url(), no comments. Box classes use the box's
 * index, never its id. `paper` is the full page (PAPER[size]); `offset` is the printer calibration (paper only);
 * `maxSpacerMm` is spacerLimitMm() for this page.
 *
 * Print mechanics (spike S1): the background and every-page boxes are position:fixed (Chromium repeats them on each
 * page); the flow table's thead and tfoot spacers repeat on each page only while each is at most 25% of the paper
 * height, which renderOverlay asserts (the 24% publish rule).
 */
export function overlayCss(def: OverlayDefinition, paper: PaperSpec, offset: { x: number; y: number }, maxSpacerMm: number): string {
  const band = def.pageNumbers.bandMm;
  // A stored version is never refused at print time: a spacer the engine would not repeat is clamped to the limit (override 21a).
  const top = Math.min(maxSpacerMm, Math.max(0, def.flow.topMm + offset.y));
  const bottom = Math.min(maxSpacerMm, Math.max(0, def.flow.bottomMm - band - offset.y));
  const left = Math.max(0, def.flow.leftMm + offset.x);
  const right = Math.max(0, def.flow.rightMm - offset.x);
  return [
    `.overlay .bg{position:fixed;left:${n(offset.x)}mm;top:${n(offset.y)}mm;width:${n(paper.widthMm)}mm;height:${n(paper.heightMm - band)}mm;z-index:0;overflow:hidden}`,
    // Above the background and the body (z-index 0 and 1), or the opaque background would hide the DRAFT/SAMPLE mark.
    ".overlay .watermark{z-index:2}",
    ".overlay .bg img{display:block;width:100%;height:100%;object-fit:cover;object-position:top}",
    ".box{position:fixed;z-index:1;overflow:visible;line-height:1.2;overflow-wrap:anywhere;white-space:pre-line}",
    ".box-first{position:absolute}",
    ".box img{display:block;max-width:100%;max-height:100%;width:auto;height:auto}",
    ".banner-sample{border:2px solid black;background:black;color:white;text-align:center;letter-spacing:.05em}",
    ".flow{position:relative;z-index:1;width:100%;border-collapse:collapse}",
    ".flow>thead{display:table-header-group}",
    ".flow>tfoot{display:table-footer-group}",
    ".flow>thead>tr>td,.flow>tfoot>tr>td{padding:0}",
    `.flow-top{height:${n(top)}mm}`,
    `.flow-bottom{height:${n(bottom)}mm}`,
    `.flow-body{padding:0 ${n(right)}mm 0 ${n(left)}mm;vertical-align:top}`,
    ...def.boxes.map(
      (box, i) =>
        `.box-${i}{left:${n(box.xMm + offset.x)}mm;top:${n(box.yMm + offset.y)}mm;width:${n(box.wMm)}mm;height:${n(box.hMm)}mm;font-size:${n(box.fontPt)}pt;text-align:${ALIGN[box.align]};font-weight:${box.bold ? 700 : 400}}`,
    ),
    // On screen there are no pages: the preview is one sheet with everything placed relative to it.
    `@media screen{body.overlay{position:relative;width:${n(paper.widthMm)}mm;min-height:${n(paper.heightMm)}mm;padding:0}.overlay .bg,.overlay .box{position:absolute}}`,
  ].join("\n");
}
