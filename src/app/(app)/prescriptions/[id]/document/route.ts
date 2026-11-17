import { getSessionContext } from "@/server/auth/session";
import { renderPrescriptionHtml } from "@/server/services/rx-output";
import { DOCUMENT_CSP } from "@/lib/rx-render/render";
import { escapeHtml } from "@/lib/rx-render/html";
import { contentDisposition, crossSiteRefusal, headNotAllowed, publicMessage, statusForError } from "@/server/http/response";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const INTERNAL_MESSAGE = "The prescription could not be prepared. Reload the page and try again.";

const HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Content-Security-Policy": `${DOCUMENT_CSP}; frame-ancestors 'self'`,
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Resource-Policy": "same-origin",
};

/** data-rx="error" lets the print iframe tell an error page from a pad. */
function errorPage(message: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Prescription unavailable</title></head><body data-rx="error"><p>${escapeHtml(message)}</p></body></html>`;
}

/**
 * The pad as HTML, for the preview tab and the print iframe. ?purpose=print logs a print (a draft
 * cannot be printed). The service has already run the self-contained check on this exact markup.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const session = await getSessionContext();
    if (!session) return Response.redirect(new URL("/login", request.url), 303);
    const { id } = await params;
    const purpose = new URL(request.url).searchParams.get("purpose") === "print" ? "print" : "preview";
    if (purpose === "print") {
      const refused = crossSiteRefusal(request);
      if (refused) return refused;
    }
    const result = await renderPrescriptionHtml(session, id, purpose);
    if (!result.ok) {
      return new Response(errorPage(publicMessage(result.code, result.message)), { status: statusForError(result.code), headers: HEADERS });
    }
    return new Response(result.value.html, {
      status: 200,
      headers: { ...HEADERS, "Content-Disposition": contentDisposition("inline", result.value.fileName) },
    });
  } catch (error) {
    // Error class only: exception messages can carry row values.
    console.error("prescription document failed", error instanceof Error ? error.name : typeof error);
    return new Response(errorPage(INTERNAL_MESSAGE), { status: 500, headers: HEADERS });
  }
}

export function HEAD(): Response {
  return headNotAllowed();
}
