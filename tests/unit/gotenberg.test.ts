// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createGotenbergEngine } from "@/server/pdf/gotenberg";
import { resolveGotenbergUrl } from "@/server/pdf";
import type { RenderedDocument } from "@/lib/rx-render/types";
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

  it("counts the UTF-8 byte length, not the character count, against the size cap", async () => {
    const { calls, impl } = recorder(async () => pdfResponse(1));
    // Half as many characters as the cap, each two bytes: under the cap by length, over it by bytes.
    const filler = "é".repeat(Math.ceil(PDF_LIMITS.maxHtmlBytes / 2) + 10);
    const wide = { ...rendered, html: rendered.html.replace("</body>", `<p>${filler}</p></body>`) };
    expect(wide.html.length).toBeLessThan(PDF_LIMITS.maxHtmlBytes);
    expect(Buffer.byteLength(wide.html, "utf8")).toBeGreaterThan(PDF_LIMITS.maxHtmlBytes);
    expect(await createGotenbergEngine({ baseUrl: BASE, fetch: impl }).render(wide)).toMatchObject({ ok: false, code: "pdf_too_large" });
    expect(calls).toHaveLength(0);
  });

  it("refuses a response whose content type is not PDF even when the bytes are a valid PDF", async () => {
    const respond = async () => new Response(fakePdfBytes(1), { status: 200, headers: { "Content-Type": "text/html" } });
    expect(await createGotenbergEngine({ baseUrl: BASE, fetch: recorder(respond).impl }).render(rendered)).toMatchObject({
      ok: false,
      code: "pdf_failed",
    });
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

  it("sends A5 paper size, all four margins and the print media type", async () => {
    const a5Doc = documentFixture();
    const a5 = renderPrescription({ ...a5Doc, snapshot: { ...a5Doc.snapshot, layout: { ...a5Doc.snapshot.layout, paperSize: "A5" } } }, { logo: null, signature: null, fontCss: "" });
    const { calls, impl } = recorder(async () => pdfResponse(1));
    await createGotenbergEngine({ baseUrl: BASE, fetch: impl }).render(a5);
    const form = calls[0].init?.body as FormData;
    const inches = (mm: number) => (mm / 25.4).toFixed(3);
    expect(a5.paper.size).toBe("A5");
    expect(form.get("paperWidth")).toBe(String(a5.paper.widthIn));
    expect(form.get("paperHeight")).toBe(String(a5.paper.heightIn));
    expect(form.get("paperWidth")).not.toBe("8.27");
    expect(form.get("marginLeft")).toBe(inches(a5.paper.marginMm.left));
    expect(form.get("marginRight")).toBe(inches(a5.paper.marginMm.right));
    expect(form.get("emulatedMediaType")).toBe("print");
  });

  it("refuses a footer that is not self-contained without calling the service", async () => {
    const { calls, impl } = recorder(async () => pdfResponse(1));
    const tampered = { ...rendered, footerHtml: rendered.footerHtml.replace("</body>", '<img src="http://evil.example/x.png"></body>') };
    expect(await createGotenbergEngine({ baseUrl: BASE, fetch: impl }).render(tampered)).toMatchObject({ ok: false, code: "pdf_refused" });
    expect(calls).toHaveLength(0);
  });

  it("never throws: a malformed document becomes pdf_failed", async () => {
    const { calls, impl } = recorder(async () => pdfResponse(1));
    const engine = createGotenbergEngine({ baseUrl: BASE, fetch: impl });
    const noPaper = { ...rendered, paper: undefined } as unknown as RenderedDocument;
    const noHtml = { ...rendered, html: undefined } as unknown as RenderedDocument;
    expect(await engine.render(noPaper)).toMatchObject({ ok: false, code: "pdf_failed" });
    expect(await engine.render(noHtml)).toMatchObject({ ok: false, code: "pdf_failed" });
    expect(calls).toHaveLength(0);
  });

  it("honours the maxPages and maxPdfBytes options", async () => {
    const pages = createGotenbergEngine({ baseUrl: BASE, fetch: async () => pdfResponse(2), maxPages: 1 });
    expect(await pages.render(rendered)).toMatchObject({ ok: false, code: "pdf_too_large" });
    const bytes = createGotenbergEngine({ baseUrl: BASE, fetch: async () => pdfResponse(1), maxPdfBytes: 50 });
    expect(await bytes.render(rendered)).toMatchObject({ ok: false, code: "pdf_too_large" });
  });

  it("stops reading a streamed body at the byte cap and cancels it", async () => {
    let cancelled = false;
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(1024).fill(65));
        if (pulled > 1000) controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    const respond = async () => new Response(body, { status: 200, headers: { "Content-Type": "application/pdf" } });
    const engine = createGotenbergEngine({ baseUrl: BASE, fetch: respond, maxPdfBytes: 4096 });
    expect(await engine.render(rendered)).toMatchObject({ ok: false, code: "pdf_too_large" });
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThan(20);
  });

  it("rejects a PDF with no pages", async () => {
    const empty = async () => new Response("%PDF-1.7\n%%EOF", { status: 200, headers: { "Content-Type": "application/pdf" } });
    expect(await createGotenbergEngine({ baseUrl: BASE, fetch: empty }).render(rendered)).toMatchObject({ ok: false, code: "pdf_failed" });
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

describe("createGotenbergEngine.health failures", () => {
  it("gives up after the health timeout", async () => {
    const hang: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    const health = await createGotenbergEngine({ baseUrl: BASE, fetch: hang, healthTimeoutMs: 50 }).health();
    expect(health).toEqual({ up: false, detail: "unreachable" });
  });

  it("treats a non-JSON body as down", async () => {
    const health = await createGotenbergEngine({ baseUrl: BASE, fetch: async () => new Response("ok", { status: 200 }) }).health();
    expect(health.up).toBe(false);
  });
});

describe("resolveGotenbergUrl", () => {
  it("defaults to localhost outside production", () => {
    expect(resolveGotenbergUrl({ NODE_ENV: "development" })).toEqual({ ok: true, url: "http://localhost:3001" });
    expect(resolveGotenbergUrl({ NODE_ENV: "test", GOTENBERG_URL: "" })).toEqual({ ok: true, url: "http://localhost:3001" });
  });

  it("accepts http(s) URLs only", () => {
    expect(resolveGotenbergUrl({ NODE_ENV: "development", GOTENBERG_URL: "https://pdf.internal:8443/" })).toEqual({ ok: true, url: "https://pdf.internal:8443" });
    for (const bad of ["ftp://x", "file:///etc/passwd", "not a url", "javascript:alert(1)"]) {
      expect(resolveGotenbergUrl({ NODE_ENV: "development", GOTENBERG_URL: bad }).ok, bad).toBe(false);
    }
  });

  it("requires an explicit URL in production", () => {
    expect(resolveGotenbergUrl({ NODE_ENV: "production" }).ok).toBe(false);
    expect(resolveGotenbergUrl({ NODE_ENV: "production", GOTENBERG_URL: "" }).ok).toBe(false);
    expect(resolveGotenbergUrl({ NODE_ENV: "production", GOTENBERG_URL: "http://gotenberg:3000" })).toEqual({ ok: true, url: "http://gotenberg:3000" });
  });
});

describe("countPdfPages", () => {
  it("ignores /Type /Page text inside stream bodies", () => {
    const fake = "/Type /Page ".repeat(25);
    const text = `%PDF-1.7
1 0 obj << /Type /Pages /Count 1 >> endobj
2 0 obj << /Type /Page >> endobj
3 0 obj << /Length 300 >>
stream
${fake}
endstream
endobj
%%EOF`;
    const bytes = new TextEncoder().encode(text);
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    expect(countPdfPages(copy.buffer)).toBe(1);
  });

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
