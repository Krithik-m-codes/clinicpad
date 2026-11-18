import { DOCUMENT_CSP, documentTitle, footerTemplate, image, present, type Ctx } from "./common";
import { html, raw, userText, type SafeHtml } from "./html";
import { statusText } from "./labels";
import { signature, snapshotNote, statusBanner, watermark } from "./marks";
import { overlayCss } from "./overlay-css";
import { spacerLimitMm, type OverlayBox } from "./overlay-definition";
import { PAPER } from "./paper";
import { allergies, section } from "./sections";
import { documentCss } from "./styles";
import { toTemplateData, type TemplateData } from "./template-data";
import { TEMPLATE_DEFINITIONS, type SectionKey } from "./templates";
import type { OverlayInput, PaperSpec, RenderAssets, RenderedDocument, RenderTarget, RxDocument } from "./types";

/** Logged per output (prescription_outputs.renderer_version) for overlay pads; bump when overlay output changes. */
export const OVERLAY_RENDERER_VERSION = "overlay-1";

/** Gotenberg's footer when there is no page-number band (no margin, so nothing would show anyway). */
export const EMPTY_FOOTER = '<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>';

/** `sample`: a preview with placeholder data; draws a solid SAMPLE banner and never a signature image (override 13). */
export type OverlayRenderOptions = { target: RenderTarget; sample: boolean };

function boxContent(c: Ctx, data: TemplateData, box: OverlayBox, sample: boolean): SafeHtml | null {
  if (box.field === "clinic.logo") return image(c.assets.logo);
  // A draft is never signed (ADR-0032), and a sample is never anyone's signature, whatever the caller passed in.
  if (box.field === "doctor.signature") return c.doc.status === "draft" || sample ? null : image(c.assets.signature);
  const value = data.text[box.field];
  return present(value) ? userText(value) : null;
}

function boxMarkup(c: Ctx, data: TemplateData, box: OverlayBox, index: number, sample: boolean): SafeHtml {
  const className = `box box-${index}${box.repeat === "first_page" ? " box-first" : ""}`;
  return html`<div class="${className}">${boxContent(c, data, box, sample)}</div>`;
}

/**
 * A clinic's own pad (spec section 6.2): the background and the every-page boxes are position:fixed, so Chromium repeats
 * them on every printed page; first-page boxes are absolute; the clinical body flows inside a table whose thead and tfoot
 * spacers keep it clear of the letterhead and the footer on every page, drawn by the same section and medicine renderers
 * as the built-in pads. Pure, self-contained, and inside the same safety rules (common.ts).
 * Never throws for a stored or finalized version: a spacer taller than the print engine would repeat is clamped to
 * that limit (publishing refuses such a pad, so this only protects pads stored before a rule tightened).
 */
export function renderOverlay(input: RxDocument, inAssets: RenderAssets, overlay: OverlayInput, options: OverlayRenderOptions): RenderedDocument {
  const { paperSize, labels } = input.snapshot.layout;
  const def = overlay.definition;
  const full = PAPER[paperSize];
  const band = def.pageNumbers.bandMm;
  const paper: PaperSpec = { ...full, marginMm: { top: 0, right: 0, bottom: band, left: 0 } };
  const printing = options.target === "print";
  const offset = printing ? def.printOffsetMm : { x: 0, y: 0 };
  // A sample is never anyone's signature and has no prescription number (override 21b): enforced here whatever the caller passed.
  const doc = options.sample ? { ...input, rxNo: null } : input;
  const assets = options.sample ? { ...inAssets, signature: null } : inAssets;
  const c: Ctx = { doc, def: TEMPLATE_DEFINITIONS[def.flow.bodyStyle], lang: labels, assets, paper };
  const data = toTemplateData(doc, labels);
  const background = printing && def.background.printMode === "pdf_only" ? null : image(overlay.background);
  const title = documentTitle(doc);

  const sections = def.flow.sections
    .map((key) => ({ key, markup: section(c, key) }))
    .filter((entry): entry is { key: SectionKey; markup: SafeHtml } => entry.markup !== null);
  const endSignature = def.signature.mode === "end_of_content";
  // As on the built-in pads: the signature stays with the last block of text, never with a long medicine table.
  const last = endSignature && sections.length > 0 && sections[sections.length - 1].key !== "medicines" ? sections.pop() : undefined;
  const mark = options.sample ? html`<div class="watermark">${statusText("sampleWatermark", labels)}</div>` : watermark(c);
  const sampleBanner = options.sample ? html`<div class="banner banner-sample">${statusText("sampleWatermark", labels)}</div>` : null;

  const page = html`<!doctype html>
<html lang="${labels === "en" ? "en" : "hi"}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${DOCUMENT_CSP}">
<title>${title}</title>
<style>${raw(assets.fontCss)}
${raw(documentCss(c.def, paper))}
${raw(overlayCss(def, full, offset, spacerLimitMm(paperSize, band, offset.y)))}</style>
</head>
<body class="overlay paper-${paperSize.toLowerCase()} status-${doc.status} target-${options.target}" data-rx="ready">
${background ? html`<div class="bg">${background}</div>` : null}
${mark}
${def.boxes.map((box, i) => boxMarkup(c, data, box, i, options.sample))}
<table class="flow">
<thead><tr><td><div class="flow-top"></div></td></tr></thead>
<tfoot><tr><td><div class="flow-bottom"></div></td></tr></tfoot>
<tbody><tr><td class="flow-body">
${sampleBanner}
${statusBanner(c)}
${allergies(c)}
${def.flow.showRxMark ? html`<div class="rx-mark">R<span>x</span></div>` : null}
${sections.map((entry) => entry.markup)}
${endSignature ? html`<div class="closing">${last?.markup}${signature(c)}</div>` : null}
${snapshotNote(c)}
</td></tr></tbody>
</table>
</body>
</html>
`;
  const footerHtml = band > 0 ? footerTemplate(doc, { ...paper, marginMm: { ...paper.marginMm, left: def.flow.leftMm } }) : EMPTY_FOOTER;
  return { format: "html", html: page.value, footerHtml, paper, title };
}
