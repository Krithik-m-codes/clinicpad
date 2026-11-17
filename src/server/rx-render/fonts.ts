import { readFileSync } from "node:fs";
import path from "node:path";

/** Resolved from the project root, which is the working directory for Next.js, Vitest, and Playwright. */
export const FONT_PACKAGE_DIR = path.join(process.cwd(), "node_modules", "@fontsource", "noto-sans-devanagari");

const WEIGHTS = ["400", "700"] as const;
let cached: string | null = null;

/**
 * Rewrites a Fontsource stylesheet so every WOFF2 file is a data: URI (no network, no file
 * access at render time), drops the WOFF fallback and all comments (the self-contained checker
 * refuses CSS comments), and throws if any file reference is left.
 */
export function inlineFontCss(css: string, packageDir: string): string {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const withoutWoff = withoutComments.replace(/,\s*url\(\.\/files\/[A-Za-z0-9._-]+\.woff\)\s*format\(['"]woff['"]\)/g, "");
  const inlined = withoutWoff.replace(/url\(\.\/files\/([A-Za-z0-9._-]+\.woff2)\)/g, (_match, file: string) => {
    const data = readFileSync(path.join(packageDir, "files", file)).toString("base64");
    return `url(data:font/woff2;base64,${data})`;
  });
  if (inlined.includes("./files/")) throw new Error("Unexpected font stylesheet: a font file reference was not inlined");
  // block: print engines must never draw fallback glyphs first; data: URIs load immediately anyway.
  return inlined.replace(/font-display:\s*swap/g, "font-display: block").trim();
}

/** @font-face rules for Noto Sans Devanagari (Devanagari, Latin, Latin Extended; 400 and 700). */
export function loadFontCss(): string {
  if (cached !== null) return cached;
  cached = WEIGHTS.map((weight) => inlineFontCss(readFileSync(path.join(FONT_PACKAGE_DIR, `${weight}.css`), "utf8"), FONT_PACKAGE_DIR)).join("\n");
  return cached;
}
