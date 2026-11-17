import type { RenderedDocument } from "@/lib/rx-render/types";

export type PdfFailureCode = "pdf_unavailable" | "pdf_timeout" | "pdf_failed" | "pdf_too_large" | "pdf_refused";

export type PdfOutcome = { ok: true; pdf: ArrayBuffer; pageCount: number } | { ok: false; code: PdfFailureCode; message: string };

export type PdfHealth = { up: boolean; detail: string };

/** Turns a rendered document into a PDF. Injected so tests never need the real service. */
export interface PdfEngine {
  render(doc: RenderedDocument): Promise<PdfOutcome>;
  health(): Promise<PdfHealth>;
}

export const PDF_LIMITS = {
  maxHtmlBytes: 4 * 1024 * 1024,
  maxPdfBytes: 15 * 1024 * 1024,
  maxPages: 20,
  renderTimeoutMs: 20_000,
  healthTimeoutMs: 2_000,
} as const;

/** Shown to the user. No patient data, no internal detail. */
export const PDF_MESSAGES: Record<PdfFailureCode, string> = {
  pdf_unavailable: "The PDF service is not reachable right now. Use Print instead, or try again in a minute.",
  pdf_timeout: "The PDF took too long to generate. Try again, or use Print.",
  pdf_failed: "The PDF could not be generated. Try again, or use Print.",
  pdf_too_large: "This prescription is too long to turn into a PDF. Use Print instead.",
  pdf_refused: "This document cannot be sent to the PDF service. Use Print instead.",
};

/** Counts `/Type /Page` objects (not `/Pages`); falls back to the page tree's `/Count`. */
export function countPdfPages(pdf: ArrayBuffer): number {
  // Stream bodies (images, fonts, content) are binary and can contain any text, e.g. a JPEG comment.
  const text = new TextDecoder("latin1").decode(new Uint8Array(pdf)).replace(/stream\r?\n[\s\S]*?endstream/g, "stream endstream");
  const pages = (text.match(/\/Type\s*\/Page(?![A-Za-z])/g) ?? []).length;
  if (pages > 0) return pages;
  const tree = /\/Type\s*\/Pages\b[^>]*?\/Count\s+(\d+)/.exec(text);
  return tree ? Number(tree[1]) : 0;
}
