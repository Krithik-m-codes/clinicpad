import { getSessionContext } from "@/server/auth/session";
import { renderPrescriptionPdf } from "@/server/services/rx-output";
import { contentDisposition, publicCode, publicMessage, statusForError } from "@/server/http/response";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
const INTERNAL = { error: "internal", message: "The PDF could not be generated. Try again, or use Print." };

/** The pad as a PDF download. Errors are JSON for the Download button to show. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const session = await getSessionContext();
    if (!session) {
      return Response.json(
        { error: "unauthenticated", message: "Sign in again to download this prescription." },
        { status: 401, headers: NO_STORE },
      );
    }
    const { id } = await params;
    const result = await renderPrescriptionPdf(session, id);
    if (!result.ok) {
      return Response.json(
        { error: publicCode(result.code), message: publicMessage(result.code, result.message) },
        { status: statusForError(result.code), headers: NO_STORE },
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
