import { PDF_MESSAGES, type PdfEngine, type PdfFailureCode } from "@/server/pdf/engine";
import type { RenderedDocument } from "@/lib/rx-render/types";

export type FakePdfEngine = PdfEngine & {
  calls: RenderedDocument[];
  failWith: PdfFailureCode | null;
  up: boolean;
  pages: number;
};

/** A minimal PDF with one /Type /Page object per page (what countPdfPages counts). */
export function fakePdfBytes(pages: number): ArrayBuffer {
  const objects = Array.from({ length: pages }, (_, i) => `${i + 3} 0 obj << /Type /Page /Parent 2 0 R >> endobj`).join("\n");
  const text = `%PDF-1.7\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Count ${pages} >> endobj\n${objects}\n%%EOF\n`;
  const bytes = new TextEncoder().encode(text);
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

export function createFakePdfEngine(pages = 1): FakePdfEngine {
  const engine: FakePdfEngine = {
    calls: [],
    failWith: null,
    up: true,
    pages,
    async render(doc) {
      engine.calls.push(doc);
      if (engine.failWith) return { ok: false, code: engine.failWith, message: PDF_MESSAGES[engine.failWith] };
      return { ok: true, pdf: fakePdfBytes(engine.pages), pageCount: engine.pages };
    },
    async health() {
      return engine.up ? { up: true, detail: "fake" } : { up: false, detail: "fake down" };
    },
  };
  return engine;
}

/** One instance for vi.mock("@/server/pdf") factories and the tests that inspect it. */
export const sharedFakeEngine = createFakePdfEngine(2);

export function resetFakeEngine(engine: FakePdfEngine, pages = 2): void {
  engine.calls.length = 0;
  engine.failWith = null;
  engine.up = true;
  engine.pages = pages;
}
