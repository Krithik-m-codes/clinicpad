import { pdfIntakeEnabled } from "@/lib/templates/pdf-intake";
import { frameAsset, FRAME_HTML, frameCsp } from "@/server/templates/pdf-frame-assets";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NOT_FOUND = () => new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });

/**
 * Static, public assets of the PDF reader frame: no session, no cookies read or set, no data (ADR-0046). The sandboxed
 * frame has an opaque origin, so its module, wasm and font fetches are cross-origin CORS requests without credentials;
 * the wildcard CORS header is on these static files only, never on anything dynamic. Anything not listed is 404.
 */
export async function GET(request: Request, { params }: { params: Promise<{ asset: string[] }> }): Promise<Response> {
  if (!pdfIntakeEnabled()) return NOT_FOUND();
  const { asset } = await params;
  const name = asset.join("/");
  try {
    if (name === "frame.html") {
      const policy = frameCsp(process.env);
      if (!policy) return new Response("Unavailable", { status: 503, headers: { "Cache-Control": "no-store" } });
      return new Response(FRAME_HTML, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Security-Policy": policy.csp,
          "X-Content-Type-Options": "nosniff",
          "Referrer-Policy": "no-referrer",
          "Cache-Control": "no-store",
        },
      });
    }
    const found = frameAsset(name);
    if (!found) return NOT_FOUND();
    // No long cache: pdf.js, the frame script and the CSP change together on an upgrade, so the browser revalidates by ETag.
    const common = {
      "Access-Control-Allow-Origin": "*",
      "Cross-Origin-Resource-Policy": "cross-origin",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-cache",
      ETag: found.etag,
    };
    if (request.headers.get("if-none-match") === found.etag) return new Response(null, { status: 304, headers: common });
    return new Response(found.body as BodyInit, {
      headers: {
        ...common,
        "Content-Type": found.contentType,
      },
    });
  } catch (error) {
    console.error("pdf frame asset failed", error instanceof Error ? error.name : typeof error);
    return new Response("Unavailable", { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
