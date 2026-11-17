import { pdfServiceUp } from "@/server/pdf/health-cache";

export const dynamic = "force-dynamic";

/** Is the PDF service reachable? Up or down only: no URL, no configuration, no auth, no patient data. */
export async function GET(): Promise<Response> {
  const up = await pdfServiceUp();
  return Response.json(
    { status: up ? "up" : "down", service: "pdf" },
    { status: up ? 200 : 503, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } },
  );
}
