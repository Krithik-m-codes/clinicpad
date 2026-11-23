import { inspectBackground } from "@/lib/domain/image";
import { getSessionContext } from "@/server/auth/session";
import { crossSiteRefusal, headNotAllowed } from "@/server/http/response";
import { getTemplateFile } from "@/server/services/template-files";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
const NOT_FOUND = () => new Response(null, { status: 404, headers: NO_STORE });

/**
 * A stored pad background for the Template Studio editor. Same clinic and template.read only; every other case
 * (another clinic, a role without access, a missing or malformed id, bytes that no longer sniff as a pad image) is the
 * same 404. The Content-Type comes from sniffing the bytes, never from a stored or requested value.
 */
export async function GET(request: Request, { params }: { params: Promise<{ fileId: string }> }): Promise<Response> {
  const refused = crossSiteRefusal(request);
  if (refused) return refused;
  try {
    const session = await getSessionContext();
    if (!session) return new Response(null, { status: 401, headers: NO_STORE });
    const { fileId } = await params;
    const file = await getTemplateFile(session, fileId);
    if (!file.ok) return NOT_FOUND();
    const sniffed = inspectBackground(file.value.bytes);
    if (!sniffed.ok) return NOT_FOUND();
    return new Response(new Uint8Array(file.value.bytes), {
      status: 200,
      headers: {
        ...NO_STORE,
        "Content-Type": sniffed.info.mime,
        "Content-Length": String(file.value.bytes.length),
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "Content-Disposition": "inline",
        "Cross-Origin-Resource-Policy": "same-origin",
      },
    });
  } catch (error) {
    console.error("template file failed", error instanceof Error ? error.name : typeof error);
    return new Response(null, { status: 500, headers: NO_STORE });
  }
}

export function HEAD(): Response {
  return headNotAllowed();
}
