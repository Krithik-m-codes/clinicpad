import { handleShareGet, handleSharePost } from "@/server/http/share-route";
import { methodNotAllowed } from "@/server/http/share-pages";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Public by design (no session): /s is outside the middleware matcher. See ADR-0037.
export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }): Promise<Response> {
  const { token } = await params;
  return handleShareGet(request, token);
}

export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }): Promise<Response> {
  const { token } = await params;
  return handleSharePost(request, token);
}

export function HEAD(): Response {
  return methodNotAllowed();
}
