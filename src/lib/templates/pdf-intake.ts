/**
 * PDF intake switch. Spike S2 (docs/spikes/2026-11-18-s2-pdfjs-frame.md): GO-WITH-FALLBACK, ratified, so PDF intake is
 * on; set it to false to hide the PDF and Word options (photo or scan upload is always available). Reading a PDF
 * happens in a sandboxed frame; when it fails the wizard offers "export page 1 as an image".
 */
export const PDF_INTAKE_ENABLED = true;
export const PDF_INTAKE_LIMITS = { maxBytes: 10 * 1024 * 1024, maxPages: 50, timeoutMs: 20_000, dpi: 200 } as const;

/** A page whose render is almost all white is probably blank (a Devanagari header page is about 0.7 % ink). */
export const BLANK_RENDER_PERCENT = 0.05;
