import { checkSelfContained } from "@/lib/rx-render/self-contained";
import type { RenderedDocument } from "@/lib/rx-render/types";
import { countPdfPages, PDF_LIMITS, PDF_MESSAGES, type PdfEngine, type PdfFailureCode, type PdfOutcome } from "./engine";

export type GotenbergOptions = {
  baseUrl: string;
  fetch?: typeof fetch;
  renderTimeoutMs?: number;
  healthTimeoutMs?: number;
  maxPdfBytes?: number;
  maxPages?: number;
};

const EMPTY_HEADER = '<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>';

const failure = (code: PdfFailureCode): PdfOutcome => ({ ok: false, code, message: PDF_MESSAGES[code] });
const trimSlash = (url: string) => url.replace(/\/+$/, "");
const inches = (mm: number) => (mm / 25.4).toFixed(3);

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

function startsWithPdfMagic(pdf: ArrayBuffer): boolean {
  const head = new Uint8Array(pdf.slice(0, 5));
  return String.fromCharCode(...head) === "%PDF-";
}

/** Gotenberg Chromium form: index.html, an empty header, the page-number footer, paper and margins. */
export function gotenbergForm(doc: RenderedDocument): FormData {
  const form = new FormData();
  form.append("files", new Blob([doc.html], { type: "text/html" }), "index.html");
  form.append("files", new Blob([EMPTY_HEADER], { type: "text/html" }), "header.html");
  form.append("files", new Blob([doc.footerHtml], { type: "text/html" }), "footer.html");
  const { paper } = doc;
  form.append("paperWidth", String(paper.widthIn));
  form.append("paperHeight", String(paper.heightIn));
  form.append("marginTop", inches(paper.marginMm.top));
  form.append("marginBottom", inches(paper.marginMm.bottom));
  form.append("marginLeft", inches(paper.marginMm.left));
  form.append("marginRight", inches(paper.marginMm.right));
  form.append("preferCssPageSize", "true");
  form.append("printBackground", "true");
  form.append("emulatedMediaType", "print");
  form.append("failOnConsoleExceptions", "true");
  return form;
}

/**
 * Reads a body while counting bytes; stops (and cancels the stream) once `maxBytes` is exceeded,
 * so a hostile or broken service cannot make us buffer more than the cap.
 */
async function readCapped(response: Response, maxBytes: number): Promise<ArrayBuffer | "too_large"> {
  const reader = response.body?.getReader();
  if (!reader) return new ArrayBuffer(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return "too_large";
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out.buffer;
}

async function discard(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

/** Posts a prepared form. Callers must have checked the document; createGotenbergEngine().render does. */
export async function postHtmlToGotenberg(options: GotenbergOptions, form: FormData): Promise<PdfOutcome> {
  const fetchImpl = options.fetch ?? fetch;
  const maxBytes = options.maxPdfBytes ?? PDF_LIMITS.maxPdfBytes;
  let response: Response;
  try {
    response = await fetchImpl(`${trimSlash(options.baseUrl)}/forms/chromium/convert/html`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(options.renderTimeoutMs ?? PDF_LIMITS.renderTimeoutMs),
    });
  } catch (error) {
    return failure(isTimeout(error) ? "pdf_timeout" : "pdf_unavailable");
  }
  const early = async (code: PdfFailureCode): Promise<PdfOutcome> => {
    await discard(response);
    return failure(code);
  };
  if (response.status === 502 || response.status === 503) return early("pdf_unavailable");
  if (!response.ok) return early("pdf_failed");
  if (!(response.headers.get("content-type") ?? "").includes("application/pdf")) return early("pdf_failed");
  if (Number(response.headers.get("content-length") ?? "0") > maxBytes) return early("pdf_too_large");

  let pdf: ArrayBuffer | "too_large";
  try {
    pdf = await readCapped(response, maxBytes);
  } catch (error) {
    return failure(isTimeout(error) ? "pdf_timeout" : "pdf_failed");
  }
  if (pdf === "too_large") return failure("pdf_too_large");
  if (!startsWithPdfMagic(pdf)) return failure("pdf_failed");
  const pageCount = countPdfPages(pdf);
  if (pageCount < 1) return failure("pdf_failed");
  if (pageCount > (options.maxPages ?? PDF_LIMITS.maxPages)) return failure("pdf_too_large");
  return { ok: true, pdf, pageCount };
}

/**
 * PDF engine backed by Gotenberg's Chromium route (ADR-0007). Refuses any document that is
 * not self-contained before it leaves the process, so the renderer cannot make Chromium fetch.
 * render() never throws: every failure is a typed outcome with a safe message.
 */
export function createGotenbergEngine(options: GotenbergOptions): PdfEngine {
  const fetchImpl = options.fetch ?? fetch;
  return {
    async render(doc) {
      try {
        // Size first (cheap length test, then exact bytes): the self-contained checker would
        // otherwise report an oversize document as refused.
        if (doc.html.length > PDF_LIMITS.maxHtmlBytes) return failure("pdf_too_large");
        if (Buffer.byteLength(doc.html, "utf8") > PDF_LIMITS.maxHtmlBytes) return failure("pdf_too_large");
        for (const part of [doc.html, doc.footerHtml]) {
          if (!checkSelfContained(part).ok) return failure("pdf_refused");
        }
        return await postHtmlToGotenberg(options, gotenbergForm(doc));
      } catch {
        return failure("pdf_failed");
      }
    },
    async health() {
      try {
        const response = await fetchImpl(`${trimSlash(options.baseUrl)}/health`, {
          signal: AbortSignal.timeout(options.healthTimeoutMs ?? PDF_LIMITS.healthTimeoutMs),
        });
        if (!response.ok) {
          await discard(response);
          return { up: false, detail: `status ${response.status}` };
        }
        const body = await readCapped(response, 4096);
        if (body === "too_large") return { up: false, detail: "unexpected response" };
        const parsed = JSON.parse(new TextDecoder().decode(body)) as { status?: unknown };
        return parsed.status === "up" ? { up: true, detail: "up" } : { up: false, detail: "reported down" };
      } catch {
        return { up: false, detail: "unreachable" };
      }
    },
  };
}
