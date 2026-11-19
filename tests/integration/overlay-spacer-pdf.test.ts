// @vitest-environment node
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { renderOverlay } from "@/lib/rx-render/overlay";
import { overlayGeometryIssues, spacerLimitMm, type OverlayDefinition } from "@/lib/rx-render/overlay-definition";
import type { RenderTarget } from "@/lib/rx-render/types";
import { createGotenbergEngine, gotenbergForm, postHtmlToGotenberg } from "@/server/pdf/gotenberg";
import { loadFontCss } from "@/server/rx-render/fonts";
import { TINY_PNG, manyItems } from "../fixtures/rx-documents";
import { a5Definition, overlayDefinition, overlayDocument } from "../fixtures/overlay-documents";

/**
 * Real Gotenberg + PyMuPDF (override 21a): the repeating header spacer must still repeat on page 2 and later at the
 * edge of the geometry rule, and a stored pad past the rule (clamped by the renderer) must too. Review evidence: with a
 * 12 mm band and a 50 mm spacer (A5), a +10 mm print offset and a 50 mm spacer (A5), or a +10 mm offset and a 71 mm
 * spacer (A4), Chromium dropped the repeating spacer and page-2 rows started at the top of the page, under the boxes.
 */
const run = promisify(execFile);
const baseUrl = process.env.GOTENBERG_URL ?? "http://localhost:3001";
const health = await createGotenbergEngine({ baseUrl, renderTimeoutMs: 60_000 }).health();
const required = process.env.CI === "true" || process.env.GOTENBERG_REQUIRED === "1";
const helper = path.resolve("tests/helpers/pdf_rows.py");
const python = process.env.PYTHON ?? "python";
const hasFitz = await run(python, ["-P", "-c", "import fitz"]).then(
  () => true,
  () => false,
);
if (!health.up || !hasFitz) {
  console.warn(`SKIP overlay-spacer-pdf: Gotenberg up=${health.up}, PyMuPDF=${hasFitz} (pip install pymupdf)`);
}
describe.runIf(required && !health.up)("Gotenberg is required here", () => {
  it("is reachable", () => {
    throw new Error(`Gotenberg is required but not reachable at ${baseUrl}: ${health.detail}`);
  });
});
// PyMuPDF (AGPL, test-only, never shipped) reads the PDFs. CI installs a pinned version; skipping there would let the
// repeating-spacer rule go untested without anyone noticing (override 24).
describe.runIf(required && !hasFitz)("PyMuPDF is required here", () => {
  it("is installed", () => {
    throw new Error(`PyMuPDF is required (CI=true or GOTENBERG_REQUIRED=1) but "${python} -c 'import fitz'" failed: pip install pymupdf==1.28.0`);
  });
});

type Page = { page: number; heightMm: number; firstMm: number | null; lastBottomMm: number | null };
type Paper = "A4" | "A5";

async function pdfRows(definition: OverlayDefinition, paper: Paper, target: RenderTarget): Promise<Page[]> {
  const doc = overlayDocument({ layout: { paperSize: paper, labels: "en" }, items: manyItems(30) });
  const assets = { logo: null, signature: null, fontCss: loadFontCss() };
  const out = renderOverlay(doc, assets, { templateVersionId: "v", definition, background: TINY_PNG }, { target, sample: false });
  const result = await postHtmlToGotenberg({ baseUrl, renderTimeoutMs: 60_000 }, gotenbergForm(out));
  if (!result.ok) throw new Error(`Gotenberg refused the document: ${result.code}`);
  const dir = await mkdtemp(path.join(tmpdir(), "spacer-pdf-"));
  try {
    const file = path.join(dir, "out.pdf");
    await writeFile(file, Buffer.from(result.pdf));
    const { stdout } = await run(python, ["-P", helper, file]);
    return JSON.parse(stdout) as Page[];
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const a5 = (top: number, bottom: number, band: number, offsetY = 0): OverlayDefinition => ({
  ...a5Definition(),
  flow: { ...a5Definition().flow, topMm: top, bottomMm: bottom },
  pageNumbers: { bandMm: band },
  printOffsetMm: { x: 0, y: offsetY },
});
const a4 = (top: number, bottom: number, band: number, offsetY = 0): OverlayDefinition => {
  const base = overlayDefinition();
  return { ...base, flow: { ...base.flow, topMm: top, bottomMm: bottom }, pageNumbers: { bandMm: band }, printOffsetMm: { x: 0, y: offsetY } };
};

/** The spacer heights as the renderer draws them (clamped to the limit). */
function drawn(def: OverlayDefinition, paper: Paper, target: RenderTarget) {
  const band = def.pageNumbers.bandMm;
  const offsetY = target === "print" ? def.printOffsetMm.y : 0;
  const limit = spacerLimitMm(paper, band, offsetY);
  return { top: Math.min(limit, Math.max(0, def.flow.topMm + offsetY)), bottom: Math.min(limit, Math.max(0, def.flow.bottomMm - band - offsetY)) };
}

type Case = { name: string; def: OverlayDefinition; paper: Paper; target: RenderTarget; accepted: boolean };
const cases: Case[] = [
  { name: "A5, 12 mm band, 50 mm top spacer (review case 1: refused at publish, clamped at print)", def: a5(50, 20, 12), paper: "A5", target: "pdf", accepted: false },
  { name: "A5, 50 mm top spacer, +10 mm print offset (review case 2)", def: a5(50, 20, 0, 10), paper: "A5", target: "print", accepted: false },
  { name: "A4, 71 mm top spacer, +10 mm print offset (review case 3)", def: a4(71, 27, 0, 10), paper: "A4", target: "print", accepted: false },
  { name: "A5, 12 mm band, top spacer at the limit (47.5 mm)", def: a5(47.5, 20, 12), paper: "A5", target: "pdf", accepted: true },
  { name: "A5, +10 mm offset, top spacer at the limit (38 mm)", def: a5(38, 20, 0, 10), paper: "A5", target: "print", accepted: true },
  { name: "A5, -10 mm offset, top spacer at the limit (38 mm)", def: a5(38, 20, 0, -10), paper: "A5", target: "print", accepted: true },
  { name: "A4, +10 mm offset, top spacer at the limit (58.8 mm)", def: a4(58.8, 27, 0, 10), paper: "A4", target: "print", accepted: true },
  { name: "A5, 12 mm band, bottom spacer at the limit (59.5 mm)", def: a5(30, 59.5, 12), paper: "A5", target: "pdf", accepted: true },
  { name: "A5 without band or offset, top spacer at 50 mm", def: a5(50, 20, 0), paper: "A5", target: "pdf", accepted: true },
];

describe.runIf(health.up && hasFitz)("overlay spacers repeat on every page in real PDFs (override 21a)", () => {
  it.each(cases)(
    "$name",
    async ({ def, paper, target, accepted }) => {
      expect(overlayGeometryIssues(def, paper).length === 0).toBe(accepted);
      const pages = await pdfRows(def, paper, target);
      expect(pages.length).toBeGreaterThanOrEqual(3);
      const { top, bottom } = drawn(def, paper, target);
      const withRows = pages.filter((page) => page.firstMm !== null);
      expect(withRows.length).toBeGreaterThanOrEqual(3); // a page with no medicine word (the signature page) has nothing to measure
      for (const page of withRows) {
        // The first page and every continuation page start their rows below the spacer, and end above the footer spacer.
        expect(page.firstMm ?? 0).toBeGreaterThanOrEqual(top - 0.5);
        expect(page.lastBottomMm ?? 0).toBeLessThanOrEqual(page.heightMm - def.pageNumbers.bandMm - bottom + 0.5);
      }
    },
    90_000,
  );
});
