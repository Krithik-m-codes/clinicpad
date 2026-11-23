import { escapeHtml } from "@/lib/rx-render/html";
import { getSessionContext } from "@/server/auth/session";
import { BUSY_MESSAGE, renderPrescriptionPdf, type PdfPurpose } from "@/server/services/rx-output";
import { contentDisposition, crossSiteRefusal, headNotAllowed, publicCode, publicMessage, statusForError } from "@/server/http/response";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
  "Cross-Origin-Resource-Policy": "same-origin",
};
const UNAVAILABLE_MESSAGE = "The PDF service is not available right now. Try again, or use Print.";
const INTERNAL = { error: "internal", message: "The PDF could not be generated. Try again, or use Print." };

/** ?purpose=print opens in a new tab (overlay pads on Firefox and Safari): its errors are a readable page, not JSON. */
function failure(purpose: PdfPurpose, status: number, body: { error: string; message: string }, extra: Record<string, string> = {}): Response {
  if (purpose === "download") return Response.json(body, { status, headers: { ...NO_STORE, ...extra } });
  const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Prescription unavailable</title></head><body><p>${escapeHtml(body.message)}</p></body></html>`;
  return new Response(page, {
    status,
    headers: { ...NO_STORE, ...extra, "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "default-src 'none'" },
  });
}

/** The pad as a PDF: a download, or (?purpose=print) a PDF rendered for paper and shown inline to print from. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const refused = crossSiteRefusal(request);
  if (refused) return refused;
  const purpose: PdfPurpose = new URL(request.url).searchParams.get("purpose") === "print" ? "print" : "download";
  try {
    const session = await getSessionContext();
    if (!session) return failure(purpose, 401, { error: "unauthenticated", message: "Sign in again to download this prescription." });
    const { id } = await params;
    const result = await renderPrescriptionPdf(session, id, undefined, undefined, request.signal, purpose);
    if (!result.ok) {
      const busy = result.code === "unavailable" && result.message === BUSY_MESSAGE;
      // The engine's own text ("not configured", "not reachable") names infrastructure: show a generic line.
      const message = result.code === "unavailable" && !busy ? UNAVAILABLE_MESSAGE : publicMessage(result.code, result.message);
      return failure(purpose, statusForError(result.code), { error: publicCode(result.code), message }, busy ? { "Retry-After": "2" } : {});
    }
    return new Response(result.value.pdf, {
      status: 200,
      headers: {
        ...NO_STORE,
        "Content-Type": "application/pdf",
        "Content-Disposition": contentDisposition(purpose === "print" ? "inline" : "attachment", result.value.fileName),
        "Content-Length": String(result.value.pdf.byteLength),
      },
    });
  } catch (error) {
    // Error class only: exception messages can carry row values.
    console.error("prescription pdf failed", error instanceof Error ? error.name : typeof error);
    return failure(purpose, 500, INTERNAL);
  }
}

export function HEAD(): Response {
  return headNotAllowed();
}
