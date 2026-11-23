import { html, userText, type HtmlValue, type SafeHtml } from "./html";
import type { TemplateDefinition } from "./templates";
import type { ImageAsset, LabelLanguage, PaperSpec, RenderAssets, RxDocument } from "./types";

/*
 * Safety rules for every rx-render module: user text only through userText() or as a plain string in element
 * text; attribute values are plain strings (never SafeHtml); no user data in CSS or style
 * attributes (the stylesheet comes from documentCss(), built from fixed definitions). Every
 * user value that sits beside other text gets its OWN userText() span (see joined()): one
 * isolated span around several values would let right-to-left text reorder digits after it.
 */

/** Nothing may load: styles are inline, fonts and images are data: URIs, there are no scripts. */
export const DOCUMENT_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'";

export type Ctx = { doc: RxDocument; def: TemplateDefinition; lang: LabelLanguage; assets: RenderAssets; paper: PaperSpec };

export const positive = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n > 0;
export const present = (value: string | null | undefined): value is string => typeof value === "string" && value.trim() !== "";

/** A drafted prescription (including an amendment draft that carries its parent's number) has no Rx number. */
export function printedRxNo(doc: RxDocument): number | null {
  return doc.status !== "draft" && positive(doc.rxNo) ? doc.rxNo : null;
}

/** The printed Rx number: "12", "12 (v2)" for later versions or superseded copies, "" for drafts. */
export function rxNoText(doc: RxDocument): string {
  const no = printedRxNo(doc);
  const showVersion = positive(doc.version) && (doc.version > 1 || isSuperseded(doc));
  return no !== null ? (showVersion ? `${no} (v${doc.version})` : String(no)) : "";
}

export function documentTitle(doc: RxDocument): string {
  const no = printedRxNo(doc);
  return `Prescription ${no !== null ? `Rx-${no}` : "draft"}${positive(doc.version) ? ` v${doc.version}` : ""}`;
}

/** Every present part in its own isolated user-text span, joined by plain separator text. */
export function joined(parts: Array<string | null | undefined>, separator: string): HtmlValue[] {
  const out: HtmlValue[] = [];
  for (const part of parts) {
    if (!present(part)) continue;
    if (out.length > 0) out.push(separator);
    out.push(userText(part.trim()));
  }
  return out;
}

/**
 * Gotenberg's Chromium footer: page numbers and the Rx number only (no user text, system font is fine).
 * Chromium lays a footer out in a shrink-to-fit frame: without `html{width:100%}` and a border-box `.f` the
 * two spans sit side by side at the left ("Rx 12 v1Page 1 of 7") instead of at both edges.
 */
export function footerTemplate(doc: RxDocument, paper: PaperSpec): string {
  const no = printedRxNo(doc);
  const version = positive(doc.version) ? ` v${doc.version}` : "";
  const id = no !== null ? `Rx ${no}${version}` : "Draft";
  const side = `${paper.marginMm.left}mm`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;width:100%}body{font-family:sans-serif;font-size:7pt;color:#555}.f{width:100%;box-sizing:border-box;display:flex;justify-content:space-between;padding:0 ${side}}</style></head><body><div class="f"><span>${id}</span><span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div></body></html>`;
}

/** An embedded PNG/JPEG, or null when the asset is not what it claims to be. The data URL is a plain attribute string. */
export function image(asset: ImageAsset | null): SafeHtml | null {
  if (!asset) return null;
  if (asset.mime !== "image/png" && asset.mime !== "image/jpeg") return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(asset.base64)) return null;
  if (!Number.isSafeInteger(asset.width) || !Number.isSafeInteger(asset.height) || asset.width <= 0 || asset.height <= 0) return null;
  const dataUrl = `data:${asset.mime};base64,${asset.base64}`;
  return html`<img src="${dataUrl}" alt="" width="${asset.width}" height="${asset.height}">`;
}

export function isSuperseded(doc: RxDocument): boolean {
  return doc.supersededBy !== null || doc.status === "amended";
}
