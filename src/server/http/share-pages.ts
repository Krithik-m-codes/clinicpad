import { DEFAULT_TIME_ZONE, isValidTimeZone } from "@/lib/rx-render/format";
import { escapeHtml } from "@/lib/rx-render/html";
import { contentDisposition } from "./response";

/** On every share-route response: never cached, never indexed, never leaks the URL as a referrer. */
export const SHARE_COMMON_HEADERS = {
  "Cache-Control": "no-store, private, max-age=0",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
} as const;

const PAGE_HEADERS = {
  ...SHARE_COMMON_HEADERS,
  "Content-Type": "text/html; charset=utf-8",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
} as const;

const STYLE =
  "body{font-family:system-ui,sans-serif;margin:0;padding:24px;color:#111;background:#fff}main{max-width:28rem;margin:0 auto}" +
  "h1{font-size:1.25rem}button{font-size:1rem;padding:.75rem 1.25rem;border-radius:.5rem;border:0;background:#111;color:#fff}" +
  ".small{font-size:.875rem;color:#555}";

/* NEEDS NATIVE-SPEAKER REVIEW: the Hindi lines below (human decision, Plan 1D). */
function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow"><title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`;
}

/** The single answer for every unusable link (decision 6). It names no clinic, patient or reason. */
export function notFoundPage(): Response {
  return new Response(
    page(
      "Link not valid - ClinicPad",
      '<h1>This link is not valid</h1><p>It may have expired, been used up, or been withdrawn by the clinic. Ask the clinic to send the prescription again.</p><p lang="hi">यह लिंक मान्य नहीं है। क्लिनिक से पर्चा दोबारा भेजने को कहें।</p>',
    ),
    { status: 404, headers: PAGE_HEADERS },
  );
}

export function unavailablePage(): Response {
  return new Response(
    page("Try again later - ClinicPad", "<h1>Please try again in a few minutes</h1><p>The prescription cannot be shown right now.</p>"),
    { status: 503, headers: { ...PAGE_HEADERS, "Retry-After": "30" } },
  );
}

/** The same link opened twice at once (a double tap): the first request is still making the PDF. */
export function alreadyOpeningPage(): Response {
  return new Response(
    page("Opening - ClinicPad", "<h1>Your prescription is already opening</h1><p>This prescription is already opening. Wait a few seconds, then go back and tap again.</p>"),
    { status: 503, headers: { ...PAGE_HEADERS, "Retry-After": "5" } },
  );
}

export function tooManyPage(): Response {
  return new Response(page("Too many requests - ClinicPad", "<h1>Too many requests</h1><p>Wait a minute, then try again.</p>"), {
    status: 429,
    headers: { ...PAGE_HEADERS, "Retry-After": "60" },
  });
}

/** GET of a usable link. Link previews and scanners stop here: nothing is counted or rendered. */
export function interstitialPage(link: { expiresAt: Date; remainingOpens: number; timeZone: string }): Response {
  const zone = isValidTimeZone(link.timeZone) ? link.timeZone : DEFAULT_TIME_ZONE;
  const expires = new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: zone }).format(link.expiresAt);
  const times = `${link.remainingOpens} more time${link.remainingOpens === 1 ? "" : "s"}`;
  return new Response(
    page(
      "Prescription - ClinicPad",
      `<h1>Your prescription</h1><p>Your clinic has shared a prescription with you.</p><p lang="hi">आपके क्लिनिक ने आपका पर्चा भेजा है।</p>` +
        `<form method="post"><button type="submit">Open prescription (PDF)</button></form>` +
        `<p class="small">This link works until ${escapeHtml(expires)} and can be opened ${escapeHtml(times)}. Anyone who has the link can open it, so do not forward it.</p>`,
    ),
    { status: 200, headers: PAGE_HEADERS },
  );
}

export function pdfResponse(pdf: ArrayBuffer, fileName: string): Response {
  return new Response(pdf, {
    status: 200,
    headers: {
      ...SHARE_COMMON_HEADERS,
      "Content-Type": "application/pdf",
      "Content-Disposition": contentDisposition("inline", fileName),
      "Content-Length": String(pdf.byteLength),
      // The PDF must never be framed by another page (clickjacking of the patient's own document).
      "Content-Security-Policy": "frame-ancestors 'none'",
      "X-Frame-Options": "DENY",
    },
  });
}

export function methodNotAllowed(): Response {
  return new Response(null, { status: 405, headers: { ...SHARE_COMMON_HEADERS, Allow: "GET, POST" } });
}
