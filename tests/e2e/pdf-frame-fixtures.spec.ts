import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { FRAME_STYLE } from "@/lib/templates/pdf-frame-client";
import { minimalPdf } from "../helpers/pdfs";

/**
 * Opt-in (`npm run test:pdf-frame`, config playwright.pdf-frame.config.ts). Drives the real /pdf-frame route in the
 * parent/frame protocol the wizard uses (sandbox="allow-scripts", ready, render, JPEG reply), in Chromium, Firefox and
 * WebKit, on fixtures made for spike S2 (docs/spikes/2026-11-18-s2-pdfjs-frame.md; generated, no patient data):
 * a JPEG scan (DCT), CCITT G4, JBIG2 (MMR coded only: there is no JBIG2 encoder here, so scanner-made arithmetic or
 * symbol JBIG2 is untested), JPEG 2000, and two Devanagari documents (Chromium print, LibreOffice docx stand-in).
 * It also fails when any request under /pdf-frame/ is not 200 or the frame reports a CSP violation, which proves the
 * allow-list serves what decoding needs (the wasm decoders) and the CSP does not block it.
 */
const enabled = Boolean(process.env.PDF_FRAME);
const FIXTURES = path.join(process.cwd(), "tests", "fixtures", "pdf-intake");

type Case = { name: string; bytes: () => Buffer; minInkPercent: number; wasm?: string };
const file = (n: string) => () => readFileSync(path.join(FIXTURES, `${n}.pdf`));
const CASES: Case[] = [
  { name: "a4 text page", bytes: () => minimalPdf(595, 842, "Dr Test Clinic"), minInkPercent: 5 },
  { name: "JPEG scan (DCT)", bytes: file("jpeg-scan"), minInkPercent: 5 },
  { name: "CCITT G4 scan", bytes: file("ccitt-g4-scan"), minInkPercent: 1, wasm: "jbig2.wasm" },
  { name: "JBIG2 (MMR) scan", bytes: file("jbig2-mmr-scan"), minInkPercent: 1, wasm: "jbig2.wasm" },
  { name: "JPEG 2000 scan", bytes: file("jpx-scan"), minInkPercent: 5, wasm: "openjpeg.wasm" },
  { name: "Devanagari (Chromium print)", bytes: file("devanagari-chromium"), minInkPercent: 0.3 },
  { name: "Devanagari (LibreOffice docx)", bytes: file("devanagari-docx-libreoffice"), minInkPercent: 0.3 },
];

type Reply = { type: "image"; bytes: ArrayBuffer; width: number; height: number; pageCount: number; pageSizePt: number[]; nonWhitePercent: number } | { type: "error"; code: string };
type Outcome = { reply: { type: string; code?: string; size?: number; width?: number; height?: number; head?: number[]; nonWhitePercent?: number; pageCount?: number } | null; ms: number };

test.describe("PDF reader frame, real fixtures", () => {
  test.skip(!enabled, "opt-in: npm run test:pdf-frame");

  for (const c of CASES) {
    test(c.name, async ({ page, browserName }) => {
      const served: { url: string; status: number }[] = [];
      const violations: string[] = [];
      page.on("response", (r) => {
        if (r.url().includes("/pdf-frame/")) served.push({ url: r.url(), status: r.status() });
      });
      page.on("console", (m) => {
        if (/content security policy|refused to/i.test(m.text())) violations.push(m.text());
      });
      await page.goto("/no-such-page-host"); // any same-origin document (the app 404 page); the frame CSP allows only this origin as its ancestor
      const base64 = c.bytes().toString("base64");
      const outcome: Outcome = await page.evaluate(async ({ b64, style }) => {
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
        const started = performance.now();
        return await new Promise<Outcome>((resolve) => {
          const frame = document.createElement("iframe");
          frame.setAttribute("sandbox", "allow-scripts");
          const timer = setTimeout(() => resolve({ reply: null, ms: performance.now() - started }), 60_000);
          window.addEventListener("message", (event) => {
            if (event.source !== frame.contentWindow || event.origin !== "null") return;
            const data = event.data as Reply | { type: "ready" };
            if (data.type === "ready") {
              frame.contentWindow?.postMessage({ type: "render", bytes: bytes.buffer.slice(0), page: 1, dpi: 200 }, "*");
              return;
            }
            clearTimeout(timer);
            if (data.type === "image") {
              resolve({ reply: { type: "image", size: data.bytes.byteLength, width: data.width, height: data.height, head: [...new Uint8Array(data.bytes, 0, 3)], nonWhitePercent: data.nonWhitePercent, pageCount: data.pageCount }, ms: performance.now() - started });
            } else resolve({ reply: { type: "error", code: data.code }, ms: performance.now() - started });
          });
          Object.assign(frame.style, style); // the wizard's own styles: an off-screen frame is throttled and never finishes
          frame.src = "/pdf-frame/frame.html";
          document.body.appendChild(frame);
        });
      }, { b64: base64, style: FRAME_STYLE });

      const bad = served.filter((s) => s.status !== 200);
      expect(bad, `non-200 under /pdf-frame/ (${browserName})`).toEqual([]);
      expect(violations, "CSP violations").toEqual([]);
      expect(outcome.reply, "no reply from the frame in 60 s").not.toBeNull();
      expect(outcome.reply?.type, JSON.stringify(outcome.reply)).toBe("image");
      const r = outcome.reply!;
      expect(r.head).toEqual([0xff, 0xd8, 0xff]);
      expect(r.size).toBeLessThanOrEqual(1024 * 1024);
      expect(Math.max(r.width ?? 0, r.height ?? 0)).toBeGreaterThanOrEqual(1100);
      expect(Math.max(r.width ?? 0, r.height ?? 0)).toBeLessThanOrEqual(3600);
      expect(r.nonWhitePercent ?? 0, "blank render").toBeGreaterThan(c.minInkPercent);
      if (c.wasm) expect(served.some((s) => s.url.endsWith(`/wasm/${c.wasm}`)), `${c.wasm} was fetched`).toBe(true);
      console.log(`${browserName} | ${c.name} | ${Math.round(outcome.ms)} ms | ${r.width}x${r.height} | ${Math.round((r.size ?? 0) / 1024)} KB | ink ${r.nonWhitePercent?.toFixed(2)} % | ${served.map((s) => s.url.split("/pdf-frame/")[1]).filter((u) => /wasm|icc/.test(u)).join(",")}`);
    });
  }
});
