import { getPdfEngine } from "@/server/pdf";

export const dynamic = "force-dynamic";

/** Is the PDF service reachable? Up or down only: no URL, no configuration, no auth, no patient data. */
export async function GET(): Promise<Response> {
  let up = false;
  try {
    up = (await getPdfEngine().health()).up;
  } catch {
    up = false;
  }
  return Response.json(
    { status: up ? "up" : "down", service: "pdf" },
    { status: up ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}
