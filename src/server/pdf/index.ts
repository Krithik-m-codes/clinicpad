import type { PdfEngine } from "./engine";
import { createGotenbergEngine } from "./gotenberg";

let engine: PdfEngine | null = null;

/** The process-wide PDF engine, configured from GOTENBERG_URL (default http://localhost:3001). */
export function getPdfEngine(): PdfEngine {
  if (engine === null) engine = createGotenbergEngine({ baseUrl: process.env.GOTENBERG_URL ?? "http://localhost:3001" });
  return engine;
}
