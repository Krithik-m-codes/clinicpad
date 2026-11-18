import { BACKGROUND_LIMITS } from "@/lib/domain/image";
import { can } from "@/lib/domain/permissions";
import { getSessionContext } from "@/server/auth/session";
import { readCapped } from "@/server/http/read-capped";
import { crossSiteRefusal, publicCode, statusForError } from "@/server/http/response";
import { templateUploadLimiter } from "@/server/http/upload-limits";
import { uploadBackground } from "@/server/services/template-files";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const HEADERS = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
const TOO_LARGE = { error: "invalid", field: "file", message: "The image is larger than 1 MB. Export it again at a smaller size." };

function json(status: number, body: Record<string, unknown>, extra: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { ...HEADERS, ...extra } });
}

/**
 * Uploads one pad background (the processed image bytes as the request body). The file name and the declared type are
 * never read; the bytes decide. Nothing is logged about the content.
 *
 * This path is NOT in the middleware matcher (Next buffers a middleware request body up to 10 MB before the handler
 * runs, which would defeat the cap), so this handler authenticates itself, before it reads a byte, and enforces the
 * size cap on the stream with readCapped.
 */
export async function POST(request: Request): Promise<Response> {
  const refused = crossSiteRefusal(request);
  if (refused) return refused;
  try {
    const session = await getSessionContext();
    if (!session) return json(401, { error: "unauthenticated", message: "Sign in again to upload." });
    if (!can(session.role, "template.write")) return json(404, { error: "not_found", message: "Not found." });
    if (!templateUploadLimiter.hit(`${session.tenantId}:${session.userId}`)) {
      return json(429, { error: "unavailable", message: "Too many uploads. Wait a few minutes and try again." }, { "Retry-After": "600" });
    }
    const declared = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > BACKGROUND_LIMITS.maxBytes) return json(413, TOO_LARGE);
    const body = await readCapped(request.body, BACKGROUND_LIMITS.maxBytes);
    if (body === "too_large") return json(413, TOO_LARGE);
    if (body.byteLength === 0) return json(422, { error: "invalid", field: "file", message: "The file is empty." });
    const result = await uploadBackground(session, new Uint8Array(body), {});
    if (!result.ok) {
      const retry: Record<string, string> = result.code === "unavailable" ? { "Retry-After": "60" } : {};
      return json(statusForError(result.code), { error: publicCode(result.code), message: result.message, field: result.field }, retry);
    }
    const { id, width, height, byteSize, reused } = result.value;
    return json(201, { fileId: id, width, height, byteSize, reused });
  } catch (error) {
    // Error class only: exception messages can carry row values.
    console.error("template upload failed", error instanceof Error ? error.name : typeof error);
    return json(500, { error: "internal", message: "The file could not be saved. Try again." });
  }
}

export function GET(): Response {
  return new Response(null, { status: 405, headers: { Allow: "POST", "Cache-Control": "no-store" } });
}
