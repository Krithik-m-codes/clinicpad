/**
 * PDF intake switch. Spike S2 (docs/spikes/2026-11-18-s2-pdfjs-frame.md): GO-WITH-FALLBACK, ratified, so PDF intake is
 * on. The kill switch is the PDF_INTAKE environment variable (off, 0 or false): the wizard then hides the PDF option
 * and /pdf-frame/ answers 404 (photo or scan upload is always available). Reading a PDF happens in a sandboxed
 * frame; when it fails the wizard offers "export page 1 as an image".
 */
export function pdfIntakeEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return !["off", "0", "false"].includes((env.PDF_INTAKE ?? "").trim().toLowerCase());
}
export const PDF_INTAKE_LIMITS = { maxBytes: 10 * 1024 * 1024, maxPages: 50, timeoutMs: 20_000, readyTimeoutMs: 5_000, dpi: 200 } as const;

/** A page whose render is almost all white is probably blank (a Devanagari header page is about 0.7 % ink). */
export const BLANK_RENDER_PERCENT = 0.05;
