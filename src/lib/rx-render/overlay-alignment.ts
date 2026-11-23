import { DOCUMENT_CSP } from "./common";
import { TEMPLATE_FIELDS } from "./fields";
import { html, raw } from "./html";
import { n, overlayCss } from "./overlay-css";
import { spacerLimitMm, type OverlayDefinition } from "./overlay-definition";
import { PAPER } from "./paper";
import type { PaperSize } from "./types";

/**
 * One page to print on the clinic's own pre-printed pad (spec section 10.1): every box and the body region outlined
 * where ClinicPad will print them, with the printer offset applied, and no background. Labels are the catalogue's
 * fixed English names (never user text). Self-contained like every document; every length uses the shared formatter.
 */
export function renderAlignmentCheck(def: OverlayDefinition, paperSize: PaperSize, fontCss: string): string {
  const paper = PAPER[paperSize];
  const offset = def.printOffsetMm;
  const css = [
    `@page{size:${paperSize} portrait;margin:0}`,
    'html,body{margin:0;padding:0;background:#fff;color:#111;font-family:"Noto Sans Devanagari",sans-serif;font-size:9pt}',
    overlayCss(def, paper, offset, spacerLimitMm(paperSize, def.pageNumbers.bandMm, offset.y)),
    ".box{border:0.3mm dashed #b91c1c;color:#b91c1c;box-sizing:border-box}",
    `.flow-outline{position:fixed;left:${n(Math.max(0, def.flow.leftMm + offset.x))}mm;right:${n(Math.max(0, def.flow.rightMm - offset.x))}mm;top:${n(Math.max(0, def.flow.topMm + offset.y))}mm;bottom:${n(Math.max(0, def.flow.bottomMm - offset.y))}mm;border:0.3mm dashed #1d4ed8;color:#1d4ed8;padding:1mm;box-sizing:border-box}`,
    ".note{position:fixed;left:10mm;right:10mm;bottom:3mm;margin:0;font-size:8pt;color:#333}",
  ].join("\n");
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${DOCUMENT_CSP}">
<title>Alignment check</title>
<style>${raw(fontCss)}
${raw(css)}</style>
</head>
<body class="overlay" data-rx="ready">
${def.boxes.map((box, i) => html`<div class="${`box box-${i}`}">${TEMPLATE_FIELDS[box.field].en}</div>`)}
<div class="flow-outline">Prescription body</div>
<p class="note">Print this page on your pre-printed pad at "Actual size" (100%), then hold it against the light. If the red boxes sit off their places, change the printer adjustment in Template Studio and print this page again.</p>
</body>
</html>
`.value;
}
