import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { resolveAppUrl } from "@/server/sharing/config";
import { FRAME_SCRIPT } from "./pdf-frame-script";

/**
 * The PDF reader frame (ADR-0046, spec section 6.3): pdf.js runs ONLY inside <iframe sandbox="allow-scripts"> (an
 * opaque origin: no cookies, no storage, no access to the app), with eval off, and answers the parent with a JPEG page.
 * The server never receives a PDF. The parent (src/lib/templates/pdf-frame-client.ts) validates every reply.
 */
export const FRAME_HTML = '<!doctype html><html><head><meta charset="utf-8"><title>PDF reader</title></head><body><script type="module" src="/pdf-frame/frame.mjs"></script></body></html>';

/**
 * The frame's CSP. The origin is the configured public URL (NEXT_PUBLIC_APP_URL), never the request host, so a forged
 * Host header cannot widen it; null when it is not configured (production fails closed). The frame can reach nothing
 * but /pdf-frame/ (connect-src), and 'wasm-unsafe-eval' lets pdf.js compile its decoders (no JavaScript eval).
 */
export function frameCsp(env: { NODE_ENV?: string; NEXT_PUBLIC_APP_URL?: string }): { csp: string } | null {
  const origin = resolveAppUrl(env);
  if (!origin) return null;
  const own = `${origin}/pdf-frame/`;
  return { csp: `sandbox allow-scripts; default-src 'none'; script-src ${own} 'wasm-unsafe-eval'; worker-src 'none'; connect-src ${own}; img-src blob: data:; style-src 'unsafe-inline'; font-src data: blob:; base-uri 'none'; form-action 'none'; frame-ancestors ${origin}` };
}

export type FrameAsset = { body: string | Uint8Array; contentType: string; etag: string };

const etagOf = (body: string | Uint8Array) => `"${createHash("sha256").update(body).digest("hex").slice(0, 32)}"`;

const PDFJS = path.join(process.cwd(), "node_modules", "pdfjs-dist");
const JS = "text/javascript; charset=utf-8";
const TEXT = "text/plain; charset=utf-8";
const BINARY = "application/octet-stream";

/** Exact allow-list of served paths (never a path join with request input). pdf.js needs these three wasm decoders; quickjs (PDF scripting) is never served. */
const WASM_FILES = ["jbig2.wasm", "openjpeg.wasm", "qcms_bg.wasm"];
const LICENCES = ["LICENSE_JBIG2", "LICENSE_OPENJPEG", "LICENSE_QCMS", "LICENSE_PDFJS_JBIG2", "LICENSE_PDFJS_OPENJPEG", "LICENSE_PDFJS_QCMS"];

type Entry = { file: string; contentType: string };
let table: Map<string, Entry> | null = null;

function assetTable(): Map<string, Entry> {
  if (table) return table;
  const t = new Map<string, Entry>();
  t.set("pdf.mjs", { file: path.join(PDFJS, "build", "pdf.min.mjs"), contentType: JS });
  t.set("pdf.worker.mjs", { file: path.join(PDFJS, "build", "pdf.worker.min.mjs"), contentType: JS });
  for (const name of WASM_FILES) t.set(`wasm/${name}`, { file: path.join(PDFJS, "wasm", name), contentType: "application/wasm" });
  for (const name of LICENCES) t.set(`wasm/${name}`, { file: path.join(PDFJS, "wasm", name), contentType: TEXT });
  t.set("iccs/CGATS001Compat-v2-micro.icc", { file: path.join(PDFJS, "iccs", "CGATS001Compat-v2-micro.icc"), contentType: BINARY });
  t.set("iccs/LICENSE", { file: path.join(PDFJS, "iccs", "LICENSE"), contentType: TEXT });
  for (const name of readdirSync(path.join(PDFJS, "standard_fonts"))) {
    const file = path.join(PDFJS, "standard_fonts", name);
    if (/^[A-Za-z0-9_-]+\.(pfb|ttf)$/.test(name)) t.set(`standard_fonts/${name}`, { file, contentType: BINARY });
    else if (/^LICENSE_[A-Z]+$/.test(name)) t.set(`standard_fonts/${name}`, { file, contentType: TEXT });
  }
  table = t;
  return t;
}

const cache = new Map<string, { bytes: Uint8Array; etag: string }>();

/** Every path served (frame.html is the route's own document). The route test pins this set. */
export function frameAssetNames(): string[] {
  return ["frame.html", "frame.mjs", ...assetTable().keys()].sort();
}

/** A static frame asset by its path under /pdf-frame/, or null (anything not listed is 404). Files are read once from node_modules (next.config.ts traces them). */
export function frameAsset(name: string): FrameAsset | null {
  if (name === "frame.mjs") return { body: FRAME_SCRIPT, contentType: JS, etag: etagOf(FRAME_SCRIPT) };
  const entry = assetTable().get(name);
  if (!entry) return null;
  let hit = cache.get(name);
  if (!hit) {
    const bytes = new Uint8Array(readFileSync(entry.file));
    hit = { bytes, etag: etagOf(bytes) };
    cache.set(name, hit);
  }
  return { body: hit.bytes, contentType: entry.contentType, etag: hit.etag };
}
