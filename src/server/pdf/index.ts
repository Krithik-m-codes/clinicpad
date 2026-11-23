import { z } from "zod";
import { PDF_MESSAGES, type PdfEngine } from "./engine";
import { createGotenbergEngine } from "./gotenberg";

const DEFAULT_URL = "http://localhost:3001";
const httpUrl = z.string().refine((value) => {
  try {
    return /^https?:$/.test(new URL(value).protocol);
  } catch {
    return false;
  }
}, "must be an http(s) URL");

export type GotenbergUrl = { ok: true; url: string } | { ok: false; detail: string };

/** GOTENBERG_URL: http(s) only. Empty means the local default in development and an error in production. */
export function resolveGotenbergUrl(env: { NODE_ENV?: string; GOTENBERG_URL?: string }): GotenbergUrl {
  const raw = (env.GOTENBERG_URL ?? "").trim();
  if (raw === "") {
    return env.NODE_ENV === "production" ? { ok: false, detail: "GOTENBERG_URL is not set" } : { ok: true, url: DEFAULT_URL };
  }
  const parsed = httpUrl.safeParse(raw);
  return parsed.success ? { ok: true, url: raw.replace(/\/+$/, "") } : { ok: false, detail: "GOTENBERG_URL must be an http(s) URL" };
}

function unconfiguredEngine(detail: string): PdfEngine {
  return {
    async render() {
      return { ok: false, code: "pdf_unavailable", message: `${PDF_MESSAGES.pdf_unavailable} (PDF service is not configured)` };
    },
    async health() {
      return { up: false, detail };
    },
  };
}

let engine: PdfEngine | null = null;

/** The process-wide PDF engine, configured from GOTENBERG_URL (see resolveGotenbergUrl). */
export function getPdfEngine(): PdfEngine {
  if (engine === null) {
    const resolved = resolveGotenbergUrl({ NODE_ENV: process.env.NODE_ENV, GOTENBERG_URL: process.env.GOTENBERG_URL });
    engine = resolved.ok ? createGotenbergEngine({ baseUrl: resolved.url }) : unconfiguredEngine(resolved.detail);
  }
  return engine;
}
