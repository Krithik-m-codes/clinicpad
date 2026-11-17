// @vitest-environment node
import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { createGotenbergEngine, gotenbergForm, postHtmlToGotenberg } from "@/server/pdf/gotenberg";
import { DOCUMENT_CSP, renderPrescription } from "@/lib/rx-render/render";
import { PAPER } from "@/lib/rx-render/paper";
import { BUILTIN_TEMPLATES, PAPER_SIZES } from "@/lib/rx-render/types";
import { loadFontCss } from "@/server/rx-render/fonts";
import { DEVANAGARI, documentFixture, manyItems, snapshot, visit } from "../fixtures/rx-documents";

const run = promisify(execFile);
const IMAGE = "gotenberg/gotenberg:8.11.0@sha256:e60da3ecc52050303c3886630aa7ed82f9486660b82a1ce6e5bf253c3b0764d4";

const baseUrl = process.env.GOTENBERG_URL ?? "http://localhost:3001";
const engine = createGotenbergEngine({ baseUrl, renderTimeoutMs: 60_000 });
const health = await engine.health();
// CI (or GOTENBERG_REQUIRED=1) must never go green without real PDF coverage.
const required = process.env.CI === "true" || process.env.GOTENBERG_REQUIRED === "1";
if (!health.up) {
  console.warn(`SKIP gotenberg-smoke: Gotenberg is not reachable at ${baseUrl} (${health.detail}). Run "docker compose up -d gotenberg".`);
}
const fonts = { logo: null, signature: null, fontCss: loadFontCss() };

describe.runIf(required && !health.up)("Gotenberg is required here", () => {
  it(`is reachable at ${baseUrl}`, () => {
    throw new Error(`Gotenberg is required (CI or GOTENBERG_REQUIRED=1) but not reachable at ${baseUrl}: ${health.detail}`);
  });
});

async function startBeacon(): Promise<{ server: Server; port: number; hits: () => number; reset: () => void }> {
  let hits = 0;
  const server = createServer((_request, response) => {
    hits += 1;
    response.writeHead(204).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "0.0.0.0", () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    server,
    port,
    hits: () => hits,
    reset: () => {
      hits = 0;
    },
  };
}

const probePage = (port: number, withCsp: boolean) =>
  `<!doctype html><html><head><meta charset="utf-8">${withCsp ? `<meta http-equiv="Content-Security-Policy" content="${DOCUMENT_CSP}">` : ""}</head><body><p>probe</p><img src="http://host.docker.internal:${port}/beacon.png"></body></html>`;

const sendProbe = (url: string, markup: string) =>
  postHtmlToGotenberg(
    { baseUrl: url, renderTimeoutMs: 30_000 },
    gotenbergForm({ format: "html", html: markup, footerHtml: "<!doctype html><html><body></body></html>", paper: PAPER.A4, title: "probe" }),
  );

const closeServer = (server: Server) => new Promise<void>((resolve) => server.close(() => resolve()));

describe.skipIf(!health.up)(`real Gotenberg at ${baseUrl} (skipped when it is not reachable)`, () => {
  const a4Doc = documentFixture({
    items: manyItems(30),
    snapshot: snapshot({ patient: { name: DEVANAGARI.name } }),
    visit: visit({ advice: DEVANAGARI.advice }),
  });
  const a5Doc = { ...a4Doc, snapshot: { ...a4Doc.snapshot, layout: { ...a4Doc.snapshot.layout, paperSize: "A5" as const } } };

  it("renders 30 medicines with Devanagari on more A5 pages than A4 pages", { timeout: 120_000 }, async () => {
    const a4 = await engine.render(renderPrescription(a4Doc, fonts));
    const a5 = await engine.render(renderPrescription(a5Doc, fonts));
    if (!a4.ok || !a5.ok) throw new Error(`render failed: ${JSON.stringify([a4.ok || a4.code, a5.ok || a5.code])}`);
    expect(new TextDecoder("latin1").decode(new Uint8Array(a4.pdf).subarray(0, 5))).toBe("%PDF-");
    expect(a4.pageCount).toBeGreaterThanOrEqual(2);
    expect(a5.pageCount).toBeGreaterThan(a4.pageCount);
  });

  for (const key of BUILTIN_TEMPLATES) {
    for (const paperSize of PAPER_SIZES) {
      it(`renders the ${key} template on ${paperSize}`, { timeout: 120_000 }, async () => {
        const doc = documentFixture({ layout: { template: { kind: "builtin", key }, paperSize, labels: "bilingual" } });
        expect(await engine.render(renderPrescription(doc, fonts))).toMatchObject({ ok: true });
      });
    }
  }

  it("deny-list blocks outside requests, with or without the document CSP", { timeout: 120_000 }, async () => {
    const beacon = await startBeacon();
    try {
      expect((await sendProbe(baseUrl, probePage(beacon.port, false))).ok).toBe(true);
      const withoutCsp = beacon.hits();
      beacon.reset();
      expect((await sendProbe(baseUrl, probePage(beacon.port, true))).ok).toBe(true);
      const withCsp = beacon.hits();
      // Zero hits only means something if the probe can observe a hit: see the positive control below.
      expect(withoutCsp, "page without CSP reached the network: the deny-list is not active").toBe(0);
      expect(withCsp, "page with CSP reached the network").toBe(0);
    } finally {
      await closeServer(beacon.server);
    }
  });

  it("runs with the isolation flags this repo configures (config drift)", async ({ skip }) => {
    let info = "";
    for (const name of ["clinicpad-gotenberg", "gotenberg"]) {
      try {
        const { stdout } = await run("docker", ["inspect", "--format", "{{json .Config.Cmd}} {{json .HostConfig.PortBindings}}", name]);
        info = stdout;
        break;
      } catch {
        // try the next name
      }
    }
    if (!info) {
      console.warn("SKIP config drift: no local container named clinicpad-gotenberg or gotenberg (the service runs elsewhere).");
      skip();
      return;
    }
    for (const flag of ["--chromium-deny-list=", "--webhook-disable", "--api-disable-download-from", "--chromium-disable-javascript=true"]) {
      expect(info, flag).toContain(flag);
    }
    expect(info).toContain('"HostIp":"127.0.0.1"');
    expect(info).not.toContain('"HostIp":""');
  });
});

describe("probe positive control", () => {
  it("sees the beacon when a Gotenberg without the deny-list renders a page without the CSP", { timeout: 180_000 }, async ({ skip }) => {
    const name = `clinicpad-gotenberg-control-${process.pid}`;
    const beacon = await startBeacon();
    try {
      let url = "";
      try {
        await run("docker", [
          "run", "-d", "--rm", "--name", name, "-p", "127.0.0.1:0:3000", "--add-host=host.docker.internal:host-gateway",
          IMAGE, "gotenberg", "--chromium-disable-javascript=true", "--chromium-deny-list=^file:(?!//\\/tmp/).*", "--log-level=warn",
        ]);
        const { stdout } = await run("docker", ["port", name, "3000/tcp"]);
        const port = /:(\d+)\s*$/m.exec(stdout.trim())?.[1];
        if (!port) throw new Error("no mapped port");
        url = `http://127.0.0.1:${port}`;
      } catch {
        console.warn("SKIP probe positive control: docker is not available to start a control container.");
        skip();
        return;
      }
      const control = createGotenbergEngine({ baseUrl: url });
      for (let i = 0; i < 40 && !(await control.health()).up; i += 1) await new Promise((resolve) => setTimeout(resolve, 1000));
      expect((await control.health()).up, "control container did not become healthy").toBe(true);
      expect((await sendProbe(url, probePage(beacon.port, false))).ok).toBe(true);
      if (beacon.hits() === 0) {
        console.warn("SKIP network probe: the container cannot reach this machine (firewall or host.docker.internal); the zero-hit assertions prove nothing here.");
        skip();
        return;
      }
      expect(beacon.hits()).toBeGreaterThan(0);
    } finally {
      await run("docker", ["rm", "-f", name]).catch(() => undefined);
      await closeServer(beacon.server);
    }
  });
});
