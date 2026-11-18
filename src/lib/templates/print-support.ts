export type BrowserFamily = "chromium" | "firefox" | "webkit" | "other";

/**
 * Which print engines print an overlay pad correctly from HTML (background and boxes repeated on every page). From
 * docs/spikes/2026-11-18-s1-overlay-print.md and override 16(e): Chromium is checked automatically; Firefox and WebKit
 * stay false until a person has checked their print preview (human check PENDING). Every false browser prints the
 * Gotenberg PDF made for paper instead (GET /prescriptions/<id>/pdf?purpose=print). Flip a value only with that evidence.
 */
export const OVERLAY_BROWSER_PRINT: Record<BrowserFamily, boolean> = { chromium: true, firefox: false, webkit: false, other: false };

/** The print engine behind a user agent. Every iOS browser is WebKit; Chromium exposes navigator.userAgentData. */
export function browserFamily(userAgent: string, hasUserAgentData: boolean): BrowserFamily {
  if (/\b(iPhone|iPad|iPod)\b/.test(userAgent)) return "webkit";
  if (/\bFirefox\/\d/.test(userAgent)) return "firefox";
  if (hasUserAgentData || /\b(Chrome|Chromium|Edg)\/\d/.test(userAgent)) return "chromium";
  if (/\bAppleWebKit\/\d/.test(userAgent) && /\bSafari\/\d/.test(userAgent)) return "webkit";
  return "other";
}

export function overlayPrintsInBrowser(family: BrowserFamily): boolean {
  return OVERLAY_BROWSER_PRINT[family];
}

/** Shown wherever a PDF is the way to print on paper: a scaled print moves every box off the pre-printed pad. */
export const PRINT_PDF_HINT = 'In the print window choose "Actual size" or 100% (not "Fit to page"), or the text will not line up.';
