import type { PaperSize, PaperSpec } from "./types";

/** Page sizes and margins shared by the print CSS and the Gotenberg request. */
export const PAPER: Record<PaperSize, PaperSpec> = {
  A4: {
    size: "A4",
    widthMm: 210,
    heightMm: 297,
    widthIn: 8.27,
    heightIn: 11.69,
    marginMm: { top: 12, right: 12, bottom: 14, left: 12 },
    baseFontPt: 10,
  },
  A5: {
    size: "A5",
    widthMm: 148,
    heightMm: 210,
    widthIn: 5.83,
    heightIn: 8.27,
    marginMm: { top: 9, right: 9, bottom: 12, left: 9 },
    baseFontPt: 8.5,
  },
};
