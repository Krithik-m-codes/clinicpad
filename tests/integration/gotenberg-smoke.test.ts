// @vitest-environment node
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { createGotenbergEngine, gotenbergForm, postHtmlToGotenberg } from "@/server/pdf/gotenberg";
import { DOCUMENT_CSP, renderPrescription } from "@/lib/rx-render/render";
import { PAPER } from "@/lib/rx-render/paper";
import { BUILTIN_TEMPLATES, PAPER_SIZES } from "@/lib/rx-render/types";
import { loadFontCss } from "@/server/rx-render/fonts";
import { DEVANAGARI, documentFixture, manyItems, snapshot, visit } from "../fixtures/rx-documents";

const baseUrl = process.env.GOTENBERG_URL ?? "http://localhost:3001";
const engine = createGotenbergEngine({ baseUrl, renderTimeoutMs: 60_000 });
const health = await engine.health();
if (!health.up) {
  console.warn(`SKIP gotenberg-smoke: Gotenberg is not reachable at ${baseUrl} (${health.detail}). Run "docker compose up -d gotenberg".`);
}
const fonts = { logo: null, signature: null, fontCss: loadFontCss() };

describe.skipIf(!health.up)(`real Gotenberg at ${baseUrl} (skipped when it is not reachable)`, () => {
  it("renders 30 medicines with Devanagari on more A5 pages than A4 pages", async () => {
    const base = documentFixture({
      items: manyItems(30),
      snapshot: snapshot({ patient: { name: DEVANAGARI.name } }),
      visit: visit({ advice: DEVANAGARI.advice }),
    });
    const a4 = await engine.render(renderPrescription(base, fonts));
    const a5 = await engine.render(
      renderPrescription({ ...base, snapshot: { ...base.snapshot, layout: { ...base.snapshot.layout, paperSize: "A5" } } }, fonts),
    );
    if (!a4.ok || !a5.ok) throw new Error(`render failed: ${JSON.stringify([a4.ok || a4.code, a5.ok || a5.code])}`);
    expect(new TextDecoder("latin1").decode(new Uint8Array(a4.pdf).subarray(0, 5))).toBe("%PDF-");
    expect(a4.pageCount).toBeGreaterThanOrEqual(2);
    expect(a5.pageCount).toBeGreaterThan(a4.pageCount);
  });

  it("renders every template on both paper sizes", async () => {
    for (const key of BUILTIN_TEMPLATES) {
      for (const paperSize of PAPER_SIZES) {
        const doc = documentFixture({ layout: { template: { kind: "builtin", key }, paperSize, labels: "bilingual" } });
        const outcome = await engine.render(renderPrescription(doc, fonts));
        expect(outcome, `${key} ${paperSize}`).toMatchObject({ ok: true });
      }
    }
  });

  it("loads nothing from the network once the document CSP is present", async () => {
    let hits = 0;
    const server = createServer((_request, response) => {
      hits += 1;
      response.writeHead(204).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "0.0.0.0", () => resolve()));
    const { port } = server.address() as AddressInfo;
    const page = (withCsp: boolean) =>
      `<!doctype html><html><head><meta charset="utf-8">${withCsp ? `<meta http-equiv="Content-Security-Policy" content="${DOCUMENT_CSP}">` : ""}</head><body><p>probe</p><img src="http://host.docker.internal:${port}/beacon.png"></body></html>`;
    const send = (markup: string) =>
      postHtmlToGotenberg(
        { baseUrl, renderTimeoutMs: 30_000 },
        gotenbergForm({ format: "html", html: markup, footerHtml: "<!doctype html><html><body></body></html>", paper: PAPER.A4, title: "probe" }),
      );
    try {
      // Control: without the CSP the beacon may be fetched, unless the service's own deny-list
      // (--chromium-deny-list in docker-compose.yml) already blocks it; both are fine, the
      // invariant is that the real document, which carries the CSP, never reaches the network.
      expect((await send(page(false))).ok).toBe(true);
      hits = 0;
      expect((await send(page(true))).ok).toBe(true);
      expect(hits).toBe(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
