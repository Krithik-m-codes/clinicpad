// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/pdf-frame/[...asset]/route";

const get = (asset: string, host = "https://clinic.example") => GET(new Request(`${host}/pdf-frame/${asset}`, { headers: { cookie: "authjs.session-token=SECRET" } }), { params: Promise.resolve({ asset: asset.split("/") }) });

afterEach(() => vi.unstubAllEnvs());

describe("/pdf-frame", () => {
  it("serves the frame as a sandboxed document that may load scripts only from /pdf-frame/", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://clinic.example");
    const response = await get("frame.html");
    expect(response.status).toBe(200);
    const csp = response.headers.get("content-security-policy") ?? "";
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
    expect(frame).toContain("enableScripting: false");
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
