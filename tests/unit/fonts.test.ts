// @vitest-environment node
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { inlineFontCss, loadFontCss } from "@/server/rx-render/fonts";
import { checkSelfContained, MAX_DOCUMENT_CHARS } from "@/lib/rx-render/self-contained";
import { renderPrescription } from "@/lib/rx-render/render";
import { documentFixture } from "../fixtures/rx-documents";

describe("loadFontCss", () => {
  it("inlines every Noto Sans Devanagari face as WOFF2 data and nothing else", () => {
    const css = loadFontCss();
    expect(css).toMatch(/font-family:\s*['"]Noto Sans Devanagari['"]/);
    expect((css.match(/@font-face/g) ?? []).length).toBeGreaterThanOrEqual(6);
    expect(css).toMatch(/U\+0900-097F/i);
    const urls = css.match(/url\(([^)]*)\)/g) ?? [];
    expect(urls.length).toBeGreaterThanOrEqual(6);
    for (const url of urls) expect(url.startsWith("url(data:font/woff2;base64,")).toBe(true);
    expect(css).not.toContain("./files/");
    expect(css).not.toContain("font-display: swap");
    expect(css).not.toContain("/*");
    expect(checkSelfContained(`<style>${css}</style>`)).toEqual({ ok: true });
  });

  it("is cached", () => {
    expect(loadFontCss()).toBe(loadFontCss());
  });

  it("passes the self-contained check inside a rendered document and stays far below the size cap", () => {
    const css = loadFontCss();
    const rendered = renderPrescription(documentFixture(), { logo: null, signature: null, fontCss: css });
    expect(rendered.html).toContain("Noto Sans Devanagari");
    expect(checkSelfContained(rendered.html)).toEqual({ ok: true });
    expect(css.length).toBeLessThan(MAX_DOCUMENT_CHARS / 4);
    expect(rendered.html.length).toBeLessThan(MAX_DOCUMENT_CHARS / 4);
  });
});

describe("inlineFontCss", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "fonts-"));
  mkdirSync(path.join(dir, "files"));
  writeFileSync(path.join(dir, "files", "a.woff2"), Buffer.from([1, 2, 3]));

  it("replaces relative WOFF2 URLs and drops the WOFF fallback", () => {
    const css = "@font-face{font-family:'X';font-display: swap;src:url(./files/a.woff2) format('woff2'), url(./files/a.woff) format('woff');}";
    expect(inlineFontCss(css, dir)).toBe("@font-face{font-family:'X';font-display: block;src:url(data:font/woff2;base64,AQID) format('woff2');}");
  });

  it("strips CSS comments", () => {
    expect(inlineFontCss("/* head */@font-face{src:url(./files/a.woff2) format('woff2')}/* x */", dir)).not.toContain("/*");
  });

  it("fails loudly on a reference it cannot inline", () => {
    expect(() => inlineFontCss("@font-face{src:url(./files/a.ttf)}", dir)).toThrow("not inlined");
    expect(() => inlineFontCss("@font-face{src:url(./files/missing.woff2) format('woff2')}", dir)).toThrow();
  });
});
