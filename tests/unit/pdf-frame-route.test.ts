// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/pdf-frame/[...asset]/route";
import { BACKGROUND_LIMITS } from "@/lib/domain/image";
import { PDF_INTAKE_LIMITS, pdfIntakeEnabled } from "@/lib/templates/pdf-intake";
import { FRAME_MAX_IMAGE_PIXELS, FRAME_SCRIPT } from "@/server/templates/pdf-frame-script";
import { frameAssetNames } from "@/server/templates/pdf-frame-assets";

const get = (asset: string, host = "https://clinic.example") => GET(new Request(`${host}/pdf-frame/${asset}`, { headers: { cookie: "authjs.session-token=SECRET" } }), { params: Promise.resolve({ asset: asset.split("/") }) });

afterEach(() => vi.unstubAllEnvs());

describe("PDF_INTAKE kill switch", () => {
  it("is on unless the environment says off, 0 or false", () => {
    expect(pdfIntakeEnabled({})).toBe(true);
    expect(pdfIntakeEnabled({ PDF_INTAKE: "on" })).toBe(true);
    for (const v of ["off", "OFF", "0", "false", " False "]) expect(pdfIntakeEnabled({ PDF_INTAKE: v })).toBe(false);
  });

  it("answers 404 for the frame and its assets when off, and serves them again when on", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://clinic.example");
    vi.stubEnv("PDF_INTAKE", "off");
    expect((await get("frame.html")).status).toBe(404);
    expect((await get(frameAssetNames()[0])).status).toBe(404);
    vi.stubEnv("PDF_INTAKE", "on");
    expect((await get("frame.html")).status).toBe(200);
  });
});

describe("/pdf-frame", () => {
  it("serves the frame as a sandboxed document that may load scripts only from /pdf-frame/", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://clinic.example");
    const response = await get("frame.html");
    expect(response.status).toBe(200);
    const csp = response.headers.get("content-security-policy") ?? "";
    // The whole policy, pinned: any widening (a new source, a dropped directive) must be a deliberate edit of this line.
    expect(csp).toBe("sandbox allow-scripts; default-src 'none'; script-src https://clinic.example/pdf-frame/ 'wasm-unsafe-eval'; worker-src 'none'; connect-src https://clinic.example/pdf-frame/; img-src blob: data:; style-src 'unsafe-inline'; font-src data: blob:; base-uri 'none'; form-action 'none'; frame-ancestors https://clinic.example");
    expect(csp).toMatch(/^sandbox allow-scripts;/);
    expect(csp).not.toContain("allow-same-origin");
    expect(csp).toContain("script-src https://clinic.example/pdf-frame/ 'wasm-unsafe-eval';");
    expect(csp).toContain("connect-src https://clinic.example/pdf-frame/;");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors https://clinic.example");
    expect(await response.text()).toContain('<script type="module" src="/pdf-frame/frame.mjs"></script>');
  });

  it("takes the CSP origin from NEXT_PUBLIC_APP_URL, never from the request host", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.clinicpad.example");
    const csp = (await get("frame.html", "https://evil.example")).headers.get("content-security-policy") ?? "";
    expect(csp).toContain("script-src https://app.clinicpad.example/pdf-frame/ 'wasm-unsafe-eval';");
    expect(csp).toContain("frame-ancestors https://app.clinicpad.example");
    expect(csp).not.toContain("evil.example");
  });

  it("fails closed in production when NEXT_PUBLIC_APP_URL is unset or not https", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
    const unset = await get("frame.html");
    expect(unset.status).toBe(503);
    expect(unset.headers.get("content-security-policy")).toBeNull();
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "http://clinic.example");
    expect((await get("frame.html")).status).toBe(503);
  });

  it("falls back to local development only outside production", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
    expect((await get("frame.html")).headers.get("content-security-policy")).toContain("http://localhost:3000/pdf-frame/");
  });

  it("serves pdf.js, the worker and the frame script with CORS for the opaque-origin frame", async () => {
    for (const asset of ["frame.mjs", "pdf.mjs", "pdf.worker.mjs"]) {
      const response = await get(asset);
      expect(response.status, asset).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
      expect(response.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    }
    const frame = await (await get("frame.mjs")).text();
    expect(frame).toContain("isEvalSupported: false");
    expect(frame).not.toMatch(/enableScripting:\s*true/);
    expect(frame).not.toContain("quickjs");
    expect(frame).toContain(`maxImageSize: ${FRAME_MAX_IMAGE_PIXELS}`);
    expect(frame).toContain("task.destroy()");
    expect(frame).not.toContain("useWasm: false");
  });

  it("serves the wasm decoders, fonts and colour profile pdf.js needs, with their types", async () => {
    for (const asset of ["wasm/jbig2.wasm", "wasm/openjpeg.wasm", "wasm/qcms_bg.wasm"]) {
      const response = await get(asset);
      expect(response.status, asset).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/wasm");
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
      const bytes = new Uint8Array(await response.arrayBuffer());
      expect([...bytes.slice(0, 4)], asset).toEqual([0, 0x61, 0x73, 0x6d]);
    }
    expect((await get("iccs/CGATS001Compat-v2-micro.icc")).status).toBe(200);
    expect((await get("standard_fonts/FoxitSerif.pfb")).status).toBe(200);
    expect((await get("wasm/LICENSE_OPENJPEG")).headers.get("content-type")).toContain("text/plain");
  });

  it("serves exactly this set of paths (a new file in pdf.js or a new route entry must be a conscious change)", () => {
    expect(frameAssetNames()).toEqual([
      "frame.html",
      "frame.mjs",
      "iccs/CGATS001Compat-v2-micro.icc",
      "iccs/LICENSE",
      "pdf.mjs",
      "pdf.worker.mjs",
      ...["LICENSE_JBIG2", "LICENSE_OPENJPEG", "LICENSE_PDFJS_JBIG2", "LICENSE_PDFJS_OPENJPEG", "LICENSE_PDFJS_QCMS", "LICENSE_QCMS", "jbig2.wasm", "openjpeg.wasm", "qcms_bg.wasm"].map((n) => `wasm/${n}`),
      ...frameAssetNames().filter((n) => n.startsWith("standard_fonts/")),
    ].sort());
    const fonts = frameAssetNames().filter((n) => n.startsWith("standard_fonts/"));
    expect(fonts.length).toBeGreaterThan(10);
    expect(fonts.every((n) => /^standard_fonts\/([A-Za-z0-9_-]+\.(pfb|ttf)|LICENSE_[A-Z]+)$/.test(n))).toBe(true);
    expect(frameAssetNames().some((n) => /quickjs|nowasm|cmaps/.test(n))).toBe(false);
  });

  it("revalidates by ETag instead of caching for an hour (an upgrade changes pdf.js, the script and the CSP together)", async () => {
    const first = await get("pdf.mjs");
    const etag = first.headers.get("etag") ?? "";
    expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
    expect(first.headers.get("cache-control")).toBe("no-cache");
    const again = await GET(new Request("https://clinic.example/pdf-frame/pdf.mjs", { headers: { "if-none-match": etag } }), { params: Promise.resolve({ asset: ["pdf.mjs"] }) });
    expect(again.status).toBe(304);
    expect(again.headers.get("access-control-allow-origin")).toBe("*");
    expect((await get("frame.mjs")).headers.get("etag")).not.toBe(etag);
  });

  it("the frame script's limits are the shared limits, not copies that can drift", () => {
    const constant = (name: string) => Number(new RegExp(`const ${name} = ([0-9]+);`).exec(FRAME_SCRIPT)?.[1]);
    expect(constant("MIN_SIDE")).toBe(BACKGROUND_LIMITS.minLongSide);
    expect(constant("MAX_SIDE")).toBe(BACKGROUND_LIMITS.maxLongSide);
    expect(constant("MAX_JPEG_BYTES")).toBe(BACKGROUND_LIMITS.maxBytes);
    expect(constant("MAX_PAGES")).toBe(PDF_INTAKE_LIMITS.maxPages);
    expect(FRAME_SCRIPT).toContain("Math.min(Math.max(Number(m.dpi) || 200, 72), 300)");
  });

  it("never reads or sets a cookie and is not cached as private data", async () => {
    for (const asset of ["frame.html", "frame.mjs", "pdf.mjs", "wasm/jbig2.wasm", "standard_fonts/FoxitSerif.pfb"]) {
      const response = await get(asset);
      expect(response.headers.get("set-cookie"), asset).toBeNull();
      expect(response.headers.get("vary") ?? "", asset).not.toMatch(/cookie/i);
      expect(response.headers.get("cache-control") ?? "", asset).not.toContain("private");
    }
    expect((await get("frame.mjs")).headers.get("access-control-allow-credentials")).toBeNull();
  });

  it("serves nothing else (no traversal, no unlisted names, no quickjs scripting engine)", async () => {
    for (const asset of ["index.html", "../../package.json", "..%2F..%2Fpackage.json", "pdf.min.mjs", "PDF.MJS", "wasm/quickjs-eval.wasm", "wasm/quickjs-eval.js", "wasm/jbig2_nowasm_fallback.js", "wasm", "standard_fonts/..%2Fpackage.json", "standard_fonts/", "cmaps/Adobe-Japan1-UCS2.bcmap", "wasm/jbig2.wasm/x"]) {
      expect((await get(asset)).status, asset).toBe(404);
    }
    expect((await get("")).status).toBe(404);
  });
});
