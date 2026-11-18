import { defaultOverlayDefinition, overlayGeometryIssues, type OverlayDefinition } from "@/lib/rx-render/overlay-definition";
import { PAPER } from "@/lib/rx-render/paper";
import type { PaperSize } from "@/lib/rx-render/types";

/** A strip darker than this on average holds printed letterhead content. */
const INK = 0.06;
const tenth = (n: number) => Math.round(n * 10) / 10;
const inked = (v: number | undefined) => typeof v === "number" && Number.isFinite(v) && v > INK;

/**
 * A first layout from the background's ink (spec section 10.1 step 3): the patient strip goes 3 mm under the last
 * inked strip of the top 40 % of the page (the letterhead), the body runs from under the strip to 3 mm above the
 * first inked strip of the bottom quarter (the footer). `darkness` is one value per horizontal strip, top to bottom
 * (0 white, 1 black). Anything it cannot use gives the default layout; the user adjusts the rest.
 */
export function autoLayout(paper: PaperSize, darkness: readonly number[]): OverlayDefinition {
  const base = defaultOverlayDefinition(paper);
  if (darkness.length < 20) return base;
  const { heightMm } = PAPER[paper];
  const mmPerStrip = heightMm / darkness.length;
  let headerEnd = -1;
  for (let i = 0; i < Math.floor(darkness.length * 0.4); i += 1) if (inked(darkness[i])) headerEnd = i;
  let footerStart = darkness.length;
  for (let i = darkness.length - 1; i >= Math.floor(darkness.length * 0.75); i -= 1) if (inked(darkness[i])) footerStart = i;
  if (headerEnd < 0 && footerStart === darkness.length) return base;
  const stripY = headerEnd >= 0 ? tenth((headerEnd + 1) * mmPerStrip + 3) : base.boxes[0].yMm;
  const rowHeight = base.boxes[0].hMm;
  const def: OverlayDefinition = {
    ...base,
    boxes: base.boxes.map((box) => ({ ...box, yMm: stripY })),
    flow: {
      ...base.flow,
      topMm: tenth(stripY + rowHeight + 3),
      bottomMm: footerStart < darkness.length ? tenth(heightMm - footerStart * mmPerStrip + 3) : base.flow.bottomMm,
    },
  };
  return overlayGeometryIssues(def, paper).length === 0 ? def : base;
}
