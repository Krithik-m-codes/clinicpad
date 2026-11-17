// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createGotenbergEngine } from "@/server/pdf/gotenberg";
import { countPdfPages, PDF_LIMITS } from "@/server/pdf/engine";
import { renderPrescription } from "@/lib/rx-render/render";
import { documentFixture } from "../fixtures/rx-documents";
import { fakePdfBytes } from "../helpers/fake-pdf-engine";

const BASE = "http://gotenberg.test";
const rendered = renderPrescription(documentFixture(), { logo: null, signature: null, fontCss: "" });

type FetchInput = Parameters<typeof fetch>[0];
function recorder(respond: (input: FetchInput, init?: RequestInit) => Promise<Response>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const impl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return respond(input, init);
  };
  return { calls, impl };
}

const pdfResponse = (pages: number, headers: Record<string, string> = {}) =>
  new Response(fakePdfBytes(pages), { status: 200, headers: { "Content-Type": "application/pdf", ...headers } });

describe("createGotenbergEngine.render", () => {
  it("posts the document, an empty header, and the page-number footer to the Chromium route", async () => {
    const { calls, impl } = recorder(async () => pdfResponse(2));
    const outcome = await createGotenbergEngine({ baseUrl: `${BASE}/`, fetch: impl }).render(rendered);
    expect(outcome).toMatchObject({ ok: true, pageCount: 2 });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${BASE}/forms/chromium/convert/html`);
    expect(calls[0].init?.method).toBe("POST");
    const form = calls[0].init?.body as FormData;
    const files = form.getAll("files") as File[];
    expect(files.map((f) => f.name)).toEqual(["index.html", "header.html", "footer.html"]);
    expect(await files[0].text()).toBe(rendered.html);
    expect(await files[2].text()).toBe(rendered.footerHtml);
    expect(form.get("paperWidth")).toBe("8.27");
    expect(form.get("paperHeight")).toBe("11.69");
    expect(form.get("marginTop")).toBe("0.472");
    expect(form.get("marginBottom")).toBe("0.551");
    expect(form.get("preferCssPageSize")).toBe("true");
    expect(form.get("printBackground")).toBe("true");
  });

  it("refuses a document that is not self-contained without calling the service", async () => {
    const { calls, impl } = recorder(async () => pdfResponse(1));
    const tampered = { ...rendered, html: rendered.html.replace("</body>", '<img src="http://evil.example/x.png"></body>') };
    expect(await createGotenbergEngine({ baseUrl: BASE, fetch: impl }).render(tampered)).toMatchObject({ ok: false, code: "pdf_refused" });
    expect(calls).toHaveLength(0);
  });

  it("refuses HTML over the size cap without calling the service", async () => {
    const { calls, impl } = recorder(async () => pdfResponse(1));
    const huge = { ...rendered, html: rendered.html.replace("</body>", `<p>${"x".repeat(PDF_LIMITS.maxHtmlBytes)}</p></body>`) };
    expect(await createGotenbergEngine({ baseUrl: BASE, fetch: impl }).render(huge)).toMatchObject({ ok: false, code: "pdf_too_large" });
    expect(calls).toHaveLength(0);
  });

  it.each([
    ["a refused connection", async () => { throw new TypeError("fetch failed"); }, "pdf_unavailable"],
    ["a 503", async () => new Response("busy", { status: 503 }), "pdf_unavailable"],
    ["a 500", async () => new Response("boom", { status: 500 }), "pdf_failed"],
    ["HTML instead of a PDF", async () => new Response("<html></html>", { status: 200, headers: { "Content-Type": "text/html" } }), "pdf_failed"],
    ["a body that is not a PDF", async () => new Response("not a pdf", { status: 200, headers: { "Content-Type": "application/pdf" } }), "pdf_failed"],
    ["a declared size over the cap", async () => pdfResponse(1, { "Content-Length": String(PDF_LIMITS.maxPdfBytes + 1) }), "pdf_too_large"],
    ["more pages than the cap", async () => pdfResponse(PDF_LIMITS.maxPages + 1), "pdf_too_large"],
  ])("maps %s to %s", async (_label, respond, code) => {
    const engine = createGotenbergEngine({ baseUrl: BASE, fetch: recorder(respond).impl });
    expect(await engine.render(rendered)).toMatchObject({ ok: false, code });
  });

  it("gives up after the timeout", async () => {
    const hang: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    const engine = createGotenbergEngine({ baseUrl: BASE, fetch: hang, renderTimeoutMs: 50 });
    expect(await engine.render(rendered)).toMatchObject({ ok: false, code: "pdf_timeout" });
  });
});

describe("createGotenbergEngine.health", () => {
  it.each([
    ["up", async () => Response.json({ status: "up" }), true],
    ["reporting down", async () => Response.json({ status: "down" }, { status: 503 }), false],
    ["unreachable", async () => { throw new TypeError("fetch failed"); }, false],
  ])("is %s", async (_label, respond, up) => {
    const { calls, impl } = recorder(respond);
    expect((await createGotenbergEngine({ baseUrl: BASE, fetch: impl }).health()).up).toBe(up);
    expect(calls[0].url).toBe(`${BASE}/health`);
  });
});

describe("countPdfPages", () => {
  it("counts page objects but not the page tree", () => {
    expect(countPdfPages(fakePdfBytes(3))).toBe(3);
  });

  it("falls back to the page tree count when page objects are compressed away", () => {
    const text = "%PDF-1.7\n1 0 obj << /Type /Pages /Kids [] /Count 4 >> endobj\n%%EOF";
    const bytes = new TextEncoder().encode(text);
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    expect(countPdfPages(copy.buffer)).toBe(4);
  });
});
