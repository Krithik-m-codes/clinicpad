import type { PdfEngine } from "@/server/pdf/engine";
import type { Limiter } from "@/server/pdf/limiter";
import { openSharedPrescription, resolveShareLink } from "@/server/services/share-links";
import { clientKey, createRateLimiter, type RateLimiter } from "./rate-limit";
import { interstitialPage, notFoundPage, pdfResponse, tooManyPage, unavailablePage } from "./share-pages";

export type ShareRouteDeps = { limiter?: RateLimiter; engine?: PdfEngine; pdfLimiter?: Limiter; now?: () => Date };

/** Per client address, per process: 20 requests a minute to /s/... (production adds an edge limit). */
export const shareRouteLimiter: RateLimiter = createRateLimiter({ windowMs: 60_000, max: 20 });

function allowed(request: Request, deps: ShareRouteDeps): boolean {
  return (deps.limiter ?? shareRouteLimiter).hit(clientKey(request));
}

/**
 * Another site must not spend the patient's opens: a POST the browser says came from another site, or whose Origin
 * names another host, gets the same answer as an unknown link. A navigation from the address bar or the page's own
 * form is "same-origin" (or "none"); clients that send neither header (curl, old browsers) are not browsers
 * driven by another site, so they pass (the open limit and the rate limit still apply).
 */
function sameOrigin(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin" && site !== "none") return false;
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== "null") {
    const host = request.headers.get("host") ?? new URL(request.url).host;
    try {
      if (new URL(origin).host !== host) return false;
    } catch {
      return false;
    }
  } else if (origin === "null") {
    return false;
  }
  return true;
}

export async function handleShareGet(request: Request, token: string, deps: ShareRouteDeps = {}): Promise<Response> {
  if (!allowed(request, deps)) return tooManyPage();
  try {
    const link = await resolveShareLink(token, deps.now?.() ?? new Date());
    return link.ok ? interstitialPage(link.value) : notFoundPage();
  } catch (error) {
    console.error("share link page failed", error instanceof Error ? error.name : typeof error);
    return unavailablePage();
  }
}

export async function handleSharePost(request: Request, token: string, deps: ShareRouteDeps = {}): Promise<Response> {
  if (!allowed(request, deps)) return tooManyPage();
  if (!sameOrigin(request)) return notFoundPage();
  try {
    const opened = await openSharedPrescription(token, { engine: deps.engine, limiter: deps.pdfLimiter, signal: request.signal, now: deps.now?.() });
    if (opened.ok) return pdfResponse(opened.value.pdf, opened.value.fileName);
    return opened.code === "not_found" ? notFoundPage() : unavailablePage();
  } catch (error) {
    console.error("share link open failed", error instanceof Error ? error.name : typeof error);
    return unavailablePage();
  }
}
