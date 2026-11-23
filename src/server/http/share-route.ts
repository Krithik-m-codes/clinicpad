import type { PdfEngine } from "@/server/pdf/engine";
import type { Limiter } from "@/server/pdf/limiter";
import { openSharedPrescription, resolveShareLink } from "@/server/services/share-links";
import { resolveAppUrl } from "@/server/sharing/config";
import { shareTokenHash } from "@/server/sharing/token";
import { clientKey, createRateLimiter, type RateLimiter } from "./rate-limit";
import { alreadyOpeningPage, interstitialPage, notFoundPage, pdfResponse, tooManyPage, unavailablePage } from "./share-pages";

export type ShareRouteDeps = { limiter?: RateLimiter; tokenLimiter?: RateLimiter; engine?: PdfEngine; pdfLimiter?: Limiter; now?: () => Date };

/** Per client address, per process: 20 requests a minute to /s/... (production adds an edge limit). */
export const shareRouteLimiter: RateLimiter = createRateLimiter({ windowMs: 60_000, max: 20 });

/** Why a POST was refused, or null when it may proceed. */
function refusal(request: Request): string | null {
  const site = request.headers.get("sec-fetch-site");
  // A browser that sends Sec-Fetch-Site decides it alone: the page's own form post is "same-origin" even when
  // Referrer-Policy: no-referrer makes Chromium send "Origin: null", and an address-bar visit is "none".
  if (site !== null) return site === "same-origin" || site === "none" ? null : `sec-fetch-site ${site.slice(0, 20)}`;
  // Without it (curl, older browsers) the Origin header is the only signal: "null" is what no-referrer pages send
  // and is accepted; a named origin must be this site (the configured public URL, else the Host header).
  const origin = request.headers.get("origin");
  if (origin === null || origin === "null") return null;
  try {
    if (new URL(origin).host === expectedHost(request)) return null;
  } catch {
    return "origin unparsable";
  }
  return "origin differs";
}

function expectedHost(request: Request): string {
  const configured = process.env.NEXT_PUBLIC_APP_URL ? resolveAppUrl(process.env) : null;
  if (configured) return new URL(configured).host;
  return request.headers.get("host") ?? new URL(request.url).host;
}

/** Per link, across all addresses: a leaked link cannot be hammered from many addresses. Keyed by the token's hash, never the token. */
export const shareTokenLimiter: RateLimiter = createRateLimiter({ windowMs: 60_000, max: 30 });

function allowed(request: Request, token: string, deps: ShareRouteDeps): boolean {
  if (!(deps.limiter ?? shareRouteLimiter).hit(clientKey(request))) return false;
  return (deps.tokenLimiter ?? shareTokenLimiter).hit(shareTokenHash(token.slice(0, 200)));
}

export async function handleShareGet(request: Request, token: string, deps: ShareRouteDeps = {}): Promise<Response> {
  if (!allowed(request, token, deps)) return tooManyPage();
  try {
    const link = await resolveShareLink(token, deps.now?.() ?? new Date());
    return link.ok ? interstitialPage(link.value) : notFoundPage();
  } catch (error) {
    console.error("share link page failed", error instanceof Error ? error.name : typeof error);
    return unavailablePage();
  }
}

export async function handleSharePost(request: Request, token: string, deps: ShareRouteDeps = {}): Promise<Response> {
  if (!allowed(request, token, deps)) return tooManyPage();
  const refused = refusal(request);
  if (refused) {
    console.warn(`[share] POST refused: ${refused}`);
    return notFoundPage();
  }
  try {
    const opened = await openSharedPrescription(token, { engine: deps.engine, limiter: deps.pdfLimiter, signal: request.signal, now: deps.now?.() });
    if (opened.ok) return pdfResponse(opened.value.pdf, opened.value.fileName);
    if (opened.code === "not_found") return notFoundPage();
    return opened.code === "conflict" ? alreadyOpeningPage() : unavailablePage();
  } catch (error) {
    console.error("share link open failed", error instanceof Error ? error.name : typeof error);
    return unavailablePage();
  }
}
