import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import type { OverlayDefinition } from "@/lib/rx-render/overlay-definition";
import { renderPrescription } from "@/lib/rx-render/render";
import type { RxDocument } from "@/lib/rx-render/types";
import { countPdfPages } from "@/server/pdf/engine";
import { createGotenbergEngine } from "@/server/pdf/gotenberg";
import { loadFontCss } from "@/server/rx-render/fonts";
import { makeLetterheadPng } from "../helpers/images";
import { a5Definition, overlayDefinition, overlayDocument, OVERLAY_VERSION_ID } from "../fixtures/overlay-documents";
import { DEVANAGARI, HOSTILE, TINY_PNG, documentFixture, manyItems, snapshot, visit } from "../fixtures/rx-documents";

const fontCss = loadFontCss();
const visual = Boolean(process.env.RX_VISUAL);
const gotenbergUrl = process.env.GOTENBERG_URL ?? "http://localhost:3001";
const required = process.env.CI === "true" || process.env.GOTENBERG_REQUIRED === "1";
const PDF_DIR = path.join(process.cwd(), "test-results", "rx-visual-pdf");

type Case = { name: string; doc: RxDocument; pages: [number, number] };

const derma = { template: { kind: "builtin" as const, key: "derma" as const }, labels: "hi" as const };
const draft = { status: "draft" as const, rxNo: null, issuedAt: null, snapshotSource: "live" as const };
const CASES: Case[] = [
  { name: "general-a4-en", doc: documentFixture(), pages: [1, 1] },
  { name: "general-a4-30-medicines", doc: documentFixture({ items: manyItems(30) }), pages: [3, 5] },
  {
    name: "paediatric-a5-bilingual",
    doc: documentFixture({ layout: { template: { kind: "builtin", key: "paediatric" }, paperSize: "A5", labels: "bilingual" } }),
    pages: [1, 3],
  },
  {
    name: "paediatric-a5-bilingual-30-medicines",
    doc: documentFixture({
      layout: { template: { kind: "builtin", key: "paediatric" }, paperSize: "A5", labels: "bilingual" },
      items: manyItems(30),
    }),
    pages: [5, 9],
  },
  {
    name: "derma-a4-hindi",
    doc: documentFixture({
      snapshot: snapshot({ patient: { name: DEVANAGARI.name }, layout: derma }),
      visit: visit({ advice: DEVANAGARI.advice, complaints: [DEVANAGARI.complaint] }),
    }),
    pages: [1, 3],
  },
  {
    name: "general-a5-long-hostile",
    doc: documentFixture({
      layout: { paperSize: "A5" },
      items: manyItems(30),
      visit: visit({ advice: `${HOSTILE.script} ${HOSTILE.longWord} ${DEVANAGARI.advice}` }),
    }),
    pages: [6, 10],
  },
  { name: "general-a4-draft-watermark", doc: documentFixture({ ...draft, items: manyItems(12) }), pages: [1, 3] },
  {
    name: "general-a5-draft-watermark",
    doc: documentFixture({ ...draft, layout: { paperSize: "A5", labels: "bilingual" }, items: manyItems(12) }),
    pages: [2, 4],
  },
];

const assets = { logo: TINY_PNG, signature: TINY_PNG, fontCss };

for (const c of CASES) {
  test.describe(`pad ${c.name}`, () => {
    test("loads the embedded font, fetches nothing, keeps rows whole, and paginates within bounds", async ({ page }) => {
      const rendered = renderPrescription(c.doc, assets);
      const requests: string[] = [];
      page.on("request", (request) => {
        if (!request.url().startsWith("data:")) requests.push(request.url());
      });
      await page.setContent(rendered.html, { waitUntil: "load" });

      const faces = await page.evaluate(async () => (await document.fonts.load('12px "Noto Sans Devanagari"', "आशा")).length);
      expect(faces).toBeGreaterThan(0);

      await page.emulateMedia({ media: "print" });
      const layout = await page.evaluate(() => {
        const head = document.querySelector("table.sheet > thead");
        const row = document.querySelector(".meds tbody tr");
        return {
          header: head ? getComputedStyle(head).display : "missing",
          rowBreak: row ? getComputedStyle(row).breakInside : "missing",
          closing: document.querySelectorAll(".closing").length,
          overflowing: Array.from(document.querySelectorAll(".meds td, .block-body")).filter(
            (el) => el.scrollWidth > el.clientWidth + 1,
          ).length,
          scripts: document.querySelectorAll("script").length,
        };
      });
      expect(layout).toEqual({ header: "table-header-group", rowBreak: "avoid", closing: 1, overflowing: 0, scripts: 0 });

      const pdf = await page.pdf({ preferCSSPageSize: true, printBackground: true });
      const pages = countPdfPages(new Uint8Array(pdf).buffer);
      expect(pages).toBeGreaterThanOrEqual(c.pages[0]);
      expect(pages).toBeLessThanOrEqual(c.pages[1]);
      expect(requests).toEqual([]);
    });

    test("renders through the real Gotenberg engine within the same page bounds", async () => {
      test.setTimeout(120_000);
      const engine = createGotenbergEngine({ baseUrl: gotenbergUrl, renderTimeoutMs: 60_000 });
      const health = await engine.health();
      if (!health.up) {
        if (required) throw new Error(`Gotenberg is required here but not reachable at ${gotenbergUrl}: ${health.detail}`);
        test.skip(true, `Gotenberg is not reachable at ${gotenbergUrl}; run "docker compose up -d gotenberg".`);
      }
      const outcome = await engine.render(renderPrescription(c.doc, assets));
      if (!outcome.ok) throw new Error(`Gotenberg render failed: ${outcome.code}`);
      expect(outcome.pageCount).toBeGreaterThanOrEqual(c.pages[0]);
      expect(outcome.pageCount).toBeLessThanOrEqual(c.pages[1]);
      if (visual) {
        // The real PDF is what a doctor receives: keep it for the human page-break review.
        mkdirSync(PDF_DIR, { recursive: true });
        writeFileSync(path.join(PDF_DIR, `${c.name}.pdf`), new Uint8Array(outcome.pdf));
      }
    });

    test("matches the reviewed screenshot", async ({ page }) => {
      test.skip(!visual, "Set RX_VISUAL=1 (npm run test:visual) to compare screenshots; baselines are per platform.");
      const rendered = renderPrescription(c.doc, assets);
      await page.setViewportSize({ width: c.doc.snapshot.layout.paperSize === "A5" ? 560 : 794, height: 1123 });
      await page.setContent(rendered.html, { waitUntil: "load" });
      await page.evaluate(async () => {
        await document.fonts.ready;
      });
      await page.emulateMedia({ media: "print" });
      await expect(page).toHaveScreenshot(`${c.name}.png`, { fullPage: true, maxDiffPixelRatio: 0.002 });
    });
  });
}

type OverlayCase = { name: string; doc: RxDocument; def: OverlayDefinition; target: "screen" | "print" | "pdf"; pages: [number, number]; namePerPage: string };

const A4_BG = { mime: "image/png" as const, base64: makeLetterheadPng(827, 1170, 297).toString("base64"), width: 827, height: 1170 };
const A5_BG = { mime: "image/png" as const, base64: makeLetterheadPng(583, 827, 210).toString("base64"), width: 583, height: 827 };
const OVERLAY_CASES: OverlayCase[] = [
  { name: "overlay-a4-3-medicines", doc: overlayDocument(), def: overlayDefinition(), target: "pdf", pages: [1, 2], namePerPage: "Asha Rao" },
  { name: "overlay-a4-30-medicines", doc: overlayDocument({ items: manyItems(30) }), def: overlayDefinition(), target: "pdf", pages: [3, 6], namePerPage: "Asha Rao" },
  {
    name: "overlay-a5-12-medicines-hindi",
    doc: overlayDocument({ layout: { paperSize: "A5", labels: "bilingual" }, items: manyItems(12), snapshot: snapshot({ patient: { name: DEVANAGARI.name }, layout: { template: { kind: "overlay", templateVersionId: OVERLAY_VERSION_ID, contentSha256: "ab".repeat(32) }, paperSize: "A5", labels: "bilingual" } }) }),
    def: a5Definition(),
    target: "pdf",
    pages: [2, 5],
    namePerPage: "",
  },
  { name: "overlay-a4-preprinted-print", doc: overlayDocument({ items: manyItems(12) }), def: overlayDefinition({ background: { printMode: "pdf_only" }, printOffsetMm: { x: 1.5, y: -1 } }), target: "print", pages: [1, 3], namePerPage: "Asha Rao" },
  { name: "overlay-a4-page-numbers", doc: overlayDocument({ items: manyItems(30) }), def: overlayDefinition({ pageNumbers: { bandMm: 8 }, flow: { ...overlayDefinition().flow, bottomMm: 30 } }), target: "pdf", pages: [3, 6], namePerPage: "Asha Rao" },
  { name: "overlay-a4-draft-no-signature", doc: overlayDocument({ status: "draft", rxNo: null, issuedAt: null, snapshotSource: "live", items: manyItems(12) }), def: overlayDefinition(), target: "screen", pages: [1, 3], namePerPage: "Asha Rao" },
];

async function textPerPage(pdf: ArrayBuffer): Promise<string[]> {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(pdf.slice(0)), isEvalSupported: false }).promise;
  const out: string[] = [];
  for (let n = 1; n <= doc.numPages; n += 1) out.push((await (await doc.getPage(n)).getTextContent()).items.map((i) => ("str" in i ? i.str : "")).join(" "));
  return out;
}

for (const c of OVERLAY_CASES) {
  test.describe(`pad ${c.name}`, () => {
    const overlayAssets = { ...assets, overlay: { templateVersionId: OVERLAY_VERSION_ID, definition: c.def, background: c.doc.snapshot.layout.paperSize === "A5" ? A5_BG : A4_BG } };

    test("repeats the field boxes on every page, keeps rows whole, fetches nothing", async ({ page }) => {
      const rendered = renderPrescription(c.doc, overlayAssets, { target: c.target });
      const requests: string[] = [];
      page.on("request", (r) => {
        if (!r.url().startsWith("data:")) requests.push(r.url());
      });
      await page.setContent(rendered.html, { waitUntil: "load" });
      await page.emulateMedia({ media: "print" });
      const pdf = await page.pdf({ preferCSSPageSize: true, printBackground: true });
      const pages = await textPerPage(new Uint8Array(pdf).buffer);
      expect(pages.length).toBeGreaterThanOrEqual(c.pages[0]);
      expect(pages.length).toBeLessThanOrEqual(c.pages[1]);
      if (c.namePerPage) for (const text of pages) expect(text).toContain(c.namePerPage);
      expect(requests).toEqual([]);
    });

    test("renders through the real Gotenberg engine (PDFs kept for the human review)", async () => {
      test.setTimeout(120_000);
      const engine = createGotenbergEngine({ baseUrl: gotenbergUrl, renderTimeoutMs: 60_000 });
      const health = await engine.health();
      if (!health.up) {
        if (required) throw new Error(`Gotenberg is required here but not reachable at ${gotenbergUrl}: ${health.detail}`);
        test.skip(true, `Gotenberg is not reachable at ${gotenbergUrl}; run "docker compose up -d gotenberg".`);
      }
      const outcome = await engine.render(renderPrescription(c.doc, overlayAssets, { target: c.target }));
      if (!outcome.ok) throw new Error(`Gotenberg render failed: ${outcome.code}`);
      const pages = await textPerPage(outcome.pdf);
      expect(pages.length).toBeGreaterThanOrEqual(c.pages[0]);
      expect(pages.length).toBeLessThanOrEqual(c.pages[1]);
      if (c.namePerPage) for (const text of pages) expect(text).toContain(c.namePerPage);
      if (c.def.pageNumbers.bandMm > 0) expect(pages.at(-1)).toMatch(/Page \d+ of \d+/);
      if (visual) {
        mkdirSync(PDF_DIR, { recursive: true });
        writeFileSync(path.join(PDF_DIR, `${c.name}.pdf`), new Uint8Array(outcome.pdf));
      }
    });

    test("matches the reviewed screenshot (provisional tolerance, Q9)", async ({ page }) => {
      test.skip(!visual, "Set RX_VISUAL=1 (npm run test:visual) to compare screenshots; baselines are per platform.");
      await page.setViewportSize({ width: c.doc.snapshot.layout.paperSize === "A5" ? 560 : 794, height: 1123 });
      await page.setContent(renderPrescription(c.doc, overlayAssets, { target: "screen" }).html, { waitUntil: "load" });
      await page.evaluate(async () => {
        await document.fonts.ready;
      });
      await expect(page).toHaveScreenshot(`${c.name}.png`, { fullPage: true, maxDiffPixelRatio: 0.001 });
    });
  });
}
