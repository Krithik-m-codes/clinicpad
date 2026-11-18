import { z } from "zod";
import { DOCUMENT_CSP } from "@/lib/rx-render/render";
import { escapeHtml } from "@/lib/rx-render/html";
import { SAMPLE_KINDS } from "@/lib/rx-render/samples";
import { getSessionContext } from "@/server/auth/session";
import { crossSiteRefusal, headNotAllowed, publicMessage, statusForError } from "@/server/http/response";
import { renderTemplatePreview, type PreviewSource } from "@/server/services/template-preview";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const HTML_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Content-Security-Policy": `${DOCUMENT_CSP}; frame-ancestors 'self'`,
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Resource-Policy": "same-origin",
};

const query = z.object({
  sample: z.enum(SAMPLE_KINDS).optional(),
  prescriptionId: z.uuid().optional(),
  version: z.uuid().optional(),
  format: z.enum(["html", "pdf"]).default("html"),
});

function page(status: number, message: string): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Preview unavailable</title></head><body data-rx="error"><p>${escapeHtml(message)}</p></body></html>`,
    { status, headers: HTML_HEADERS },
  );
}

/** A Template Studio preview: ?sample=short|long|blank or ?prescriptionId=..., optionally &version=... and &format=pdf. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  // A cross-site page must not trigger an audited patient preview or burn a render (same rule as the document routes).
  const refused = crossSiteRefusal(request);
  if (refused) return refused;
  try {
    const session = await getSessionContext();
    if (!session) return Response.redirect(new URL("/login", request.url), 303);
    const { id } = await params;
    const parsed = query.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!parsed.success || (parsed.data.sample === undefined) === (parsed.data.prescriptionId === undefined)) return page(404, "This preview link is not valid. Open it again from the pad.");
    const source: PreviewSource = parsed.data.prescriptionId ? { kind: "patient", prescriptionId: parsed.data.prescriptionId } : { kind: "sample", sample: parsed.data.sample ?? "short" };
    const result = await renderTemplatePreview(session, id, { source, versionId: parsed.data.version ?? null, format: parsed.data.format }, { signal: request.signal });
    if (!result.ok) return page(statusForError(result.code), publicMessage(result.code, result.message));
    if (result.value.format === "html") return new Response(result.value.html, { status: 200, headers: HTML_HEADERS });
    return new Response(result.value.pdf, {
      status: 200,
      headers: { "Content-Type": "application/pdf", "Content-Disposition": 'inline; filename="pad-preview.pdf"', "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Cross-Origin-Resource-Policy": "same-origin" },
    });
  } catch (error) {
    // Error class only: exception messages can carry row values.
    console.error("template preview failed", error instanceof Error ? error.name : typeof error);
    return page(500, "The preview could not be prepared. Try again.");
  }
}

export function HEAD(): Response {
  return headNotAllowed();
}
