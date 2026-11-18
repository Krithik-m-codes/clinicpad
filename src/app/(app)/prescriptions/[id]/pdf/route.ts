import { getSessionContext } from "@/server/auth/session";
import { BUSY_MESSAGE, renderPrescriptionPdf } from "@/server/services/rx-output";
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

/** The pad as a PDF download. Errors are JSON for the Download button to show. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const refused = crossSiteRefusal(request);
  if (refused) return refused;
  try {
    const session = await getSessionContext();
    if (!session) {
      return Response.json(
        { error: "unauthenticated", message: "Sign in again to download this prescription." },
        { status: 401, headers: NO_STORE },
      );
    }
    const { id } = await params;
    const result = await renderPrescriptionPdf(session, id, undefined, undefined, request.signal);
    if (!result.ok) {
      const busy = result.code === "unavailable" && result.message === BUSY_MESSAGE;
      // The engine's own text ("not configured", "not reachable") names infrastructure: show a generic line.
      const message = result.code === "unavailable" && !busy ? UNAVAILABLE_MESSAGE : publicMessage(result.code, result.message);
      return Response.json(
        { error: publicCode(result.code), message },
        { status: statusForError(result.code), headers: busy ? { ...NO_STORE, "Retry-After": "2" } : NO_STORE },
      );
    }
    return new Response(result.value.pdf, {
      status: 200,
      headers: {
        ...NO_STORE,
        "Content-Type": "application/pdf",
        "Content-Disposition": contentDisposition("attachment", result.value.fileName),
        "Content-Length": String(result.value.pdf.byteLength),
      },
    });
  } catch (error) {
    // Error class only: exception messages can carry row values.
    console.error("prescription pdf failed", error instanceof Error ? error.name : typeof error);
    return Response.json(INTERNAL, { status: 500, headers: NO_STORE });
  }
}

export function HEAD(): Response {
  return headNotAllowed();
}
