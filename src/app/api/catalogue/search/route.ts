import { getSessionContext } from "@/server/auth/session";
import { searchMedicines, suggestTerms } from "@/server/services/catalogue";

export const dynamic = "force-dynamic";

const HEADERS = { "Cache-Control": "private, no-store" };
const STATUS: Record<string, number> = { forbidden: 403, invalid: 400, not_found: 404 };

/**
 * Typeahead for the clinical editor. A GET route rather than a server action because
 * React runs server actions one at a time and they cannot be cancelled.
 */
export async function GET(request: Request): Promise<Response> {
  const session = await getSessionContext();
  if (!session) return Response.json({ error: "unauthenticated" }, { status: 401, headers: HEADERS });

  const params = new URL(request.url).searchParams;
  const kind = params.get("kind") ?? "medicine";
  const q = params.get("q") ?? "";

  if (kind === "medicine") {
    const result = await searchMedicines(session, { q, limit: 20 });
    return result.ok
      ? Response.json({ medicines: result.value }, { headers: HEADERS })
      : Response.json({ error: result.code }, { status: STATUS[result.code] ?? 400, headers: HEADERS });
  }

  const result = await suggestTerms(session, { kind, q, limit: 15 });
  return result.ok
    ? Response.json({ terms: result.value }, { headers: HEADERS })
    : Response.json({ error: result.code }, { status: STATUS[result.code] ?? 400, headers: HEADERS });
}
