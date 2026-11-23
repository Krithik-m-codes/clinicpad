import { DOCUMENT_CSP } from "@/lib/rx-render/render";
import { escapeHtml } from "@/lib/rx-render/html";
import { getSessionContext } from "@/server/auth/session";
import { crossSiteRefusal, headNotAllowed, publicMessage, statusForError } from "@/server/http/response";
import { renderTemplateAlignment } from "@/server/services/template-preview";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Content-Security-Policy": `${DOCUMENT_CSP}; frame-ancestors 'self'`,
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Resource-Policy": "same-origin",
};

function page(status: number, message: string): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Alignment check unavailable</title></head><body data-rx="error"><p>${escapeHtml(message)}</p></body></html>`,
    { status, headers: HEADERS },
  );
}

/** The alignment check page of a pad's open draft (or current version): template.read, no patient data, not logged. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const refused = crossSiteRefusal(request);
  if (refused) return refused;
  try {
    const session = await getSessionContext();
    if (!session) return Response.redirect(new URL("/login", request.url), 303);
    const { id } = await params;
    const result = await renderTemplateAlignment(session, id);
    if (!result.ok) return page(statusForError(result.code), publicMessage(result.code, result.message));
    return new Response(result.value, { status: 200, headers: HEADERS });
  } catch (error) {
    console.error("alignment check failed", error instanceof Error ? error.name : typeof error);
    return page(500, "The alignment check could not be prepared. Try again.");
  }
}

export function HEAD(): Response {
  return headNotAllowed();
}
