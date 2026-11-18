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
    let data: string;
    try {
      data = readFileSync(path.join(packageDir, "files", file)).toString("base64");
    } catch {
      // Not the system error: it would carry the absolute install path.
      throw new Error(`Font file ${file} could not be read from the font package`);
    }
    return `url(data:font/woff2;base64,${data})`;
  });
  if (inlined.includes("./files/")) throw new Error("Unexpected font stylesheet: a font file reference was not inlined");
  for (const match of inlined.matchAll(/url\(([^)]*)\)/g)) {
    if (!match[1].startsWith("data:font/woff2;base64,")) throw new Error("Unexpected font stylesheet: a url() is not a WOFF2 data URI");
  }
  // block: print engines must never draw fallback glyphs first; data: URIs load immediately anyway.
  return inlined.replace(/font-display:\s*swap/g, "font-display: block").trim();
}

/** @font-face rules for Noto Sans Devanagari (Devanagari, Latin, Latin Extended; 400 and 700). */
export function loadFontCss(): string {
  if (cached !== null) return cached;
  const parts = WEIGHTS.map((weight) => {
    let source: string;
    try {
      source = readFileSync(path.join(FONT_PACKAGE_DIR, `${weight}.css`), "utf8");
    } catch {
      throw new Error(`Font stylesheet ${weight}.css could not be read from the font package`);
    }
    const css = inlineFontCss(source, FONT_PACKAGE_DIR);
    const hasDevanagari = css.split("@font-face").some((face) => /U\+0900-097F/i.test(face) && face.includes(`font-weight: ${weight}`));
    if (!hasDevanagari) throw new Error(`Font stylesheet ${weight}.css has no Devanagari face`);
    return css;
  });
  cached = parts.join("\n");
  return cached;
}
