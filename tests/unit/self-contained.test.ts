import { describe, expect, it } from "vitest";
import { MAX_DOCUMENT_CHARS, MAX_TAG_STARTS, checkSelfContained } from "@/lib/rx-render/self-contained";

const PIXEL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const FONT = "data:font/woff2;base64,d09GMgABAAAAAAA=";

// Built with fromCharCode so the test source holds no invisible characters.
const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);
const NBSP = String.fromCharCode(0xa0);
const EVIL = "http://evil.example/x";

const page = (head: string, body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'"><title>x</title>${head}</head><body>${body}</body></html>`;

describe("checkSelfContained", () => {
  it("accepts inline CSS, embedded fonts, and embedded images", () => {
    const doc = page(
      `<style>@font-face{font-family:"X";src:url(${FONT}) format('woff2')}.a>.b{color:red}</style>`,
      `<table><thead><tr><th>a</th></tr></thead><tbody><tr><td><img src="${PIXEL}" alt="" width="1" height="1"></td></tr></tbody></table>`,
    );
    expect(checkSelfContained(doc)).toEqual({ ok: true });
  });

  it("accepts escaped user text that merely mentions URLs and CSS", () => {
    const text = "src=http://evil.example/a url(http://evil.example/b) @import &quot;x&quot; &lt;script&gt;";
    expect(checkSelfContained(page("", `<p><span class="v">${text}</span></p>`))).toEqual({ ok: true });
  });

  it.each([
    ["a script", page("", "<script>alert(1)</script>")],
    ["a stylesheet link", page('<link rel="stylesheet" href="http://evil.example/x.css">', "")],
    ["an image from the network", page("", '<img src="http://evil.example/x.png">')],
    ["an image from the file system", page("", '<img src="file:///etc/passwd">')],
    ["an SVG image", page("", '<img src="data:image/svg+xml;base64,PHN2Zz4=">')],
    ["an inline style with a URL", page("", '<div style="background:url(http://evil.example/x)">x</div>')],
    ["@import", page('<style>@import url("http://evil.example/x.css");</style>', "")],
    ["a font from the network", page("<style>@font-face{src:url(https://evil.example/x.woff2)}</style>", "")],
    ["a local font", page("<style>@font-face{src:local(Arial)}</style>", "")],
    ["CSS escapes", page('<style>.a{content:"\\41"}</style>', "")],
    ["an event handler", page("", '<div onclick="x()">x</div>')],
    ["a link", page("", '<a href="https://evil.example">x</a>')],
    ["a refresh meta tag", page('<meta http-equiv="refresh" content="0;url=https://evil.example">', "")],
    ["a base tag", page('<base href="https://evil.example/">', "")],
    ["an iframe", page("", '<iframe src="https://evil.example"></iframe>')],
    ["inline SVG", page("", "<svg><image href='https://evil.example/x.png'/></svg>")],
  ])("rejects %s", (_label, doc) => {
    expect(checkSelfContained(doc).ok).toBe(false);
  });

  it("explains why it rejected a document", () => {
    expect(checkSelfContained(page("", "<script></script>"))).toEqual({ ok: false, reason: "tag <script> is not allowed" });
  });

  it.each([
    ["an uppercase tag", page("", "<SCRIPT>alert(1)</SCRIPT>")],
    ["a mixed-case tag", page("", "<ScRiPt src=//evil.example/x.js></ScRiPt>")],
    ["an uppercase event handler", page("", '<div ONCLICK="x()">x</div>')],
    ["an unquoted event handler", page("", "<div onmouseover=x()>x</div>")],
    ["an event handler on a self-closing tag", page("", '<img src="' + PIXEL + '" onerror="x()"/>')],
    ["an event handler after a slash", page("", '<div/onclick="x()">x</div>')],
    ["a newline before an attribute value", page("", '<img src\n=\n"http://evil.example/x.png">')],
    ["a tab inside the attribute list", page("", '<img\tsrc="http://evil.example/x.png">')],
    ["an unquoted src", page("", "<img src=http://evil.example/x.png>")],
    ["an img with no src but srcset", page("", '<img srcset="http://evil.example/x.png 1x">')],
    ["src on a non-image tag", page("", `<div src="${PIXEL}">x</div>`)],
    ["a data image with a script payload", page("", '<img src="data:image/png;base64,AAAA<script>">')],
    ["a data image with the wrong MIME", page("", '<img src="data:text/html;base64,PHNjcmlwdD4=">')],
    ["a data image upper-case scheme trick", page("", '<img src="DATA:image/svg+xml;base64,PHN2Zz4=">')],
    ["a data URI in a link href", page("", `<a href="${PIXEL}">x</a>`)],
    ["a style attribute with @import", page("", '<div style="@import url(x)">x</div>')],
    ["a style attribute with an expression", page("", '<div style="width:expression(alert(1))">x</div>')],
    ["a style attribute with a CSS escape", page("", '<div style="background:\\75rl(http://evil.example)">x</div>')],
    ["an uppercase URL() in CSS", page("<style>.a{background:URL(http://evil.example/x)}</style>", "")],
    ["a spaced url( in CSS", page("<style>.a{background:url( 'http://evil.example/x' )}</style>", "")],
    ["a data SVG in CSS", page("<style>.a{background:url(data:image/svg+xml;base64,PHN2Zz4=)}</style>", "")],
    ["a font data URI with another MIME in CSS", page("<style>@font-face{src:url(data:font/ttf;base64,AAAA)}</style>", "")],
    ["an uppercase @IMPORT", page("<style>@IMPORT 'x.css';</style>", "")],
    ["an uppercase STYLE block", page("<STYLE>@import 'x.css';</STYLE>", "")],
    ["an object tag", page("", '<object data="http://evil.example/x"></object>')],
    ["an embed tag", page("", '<embed src="http://evil.example/x">')],
    ["a form", page("", '<form action="http://evil.example"><input></form>')],
    ["a video poster", page("", '<video poster="http://evil.example/x.png"></video>')],
    ["a meta refresh with odd case", page('<META HTTP-EQUIV="Refresh" CONTENT="0;url=http://evil.example">', "")],
    ["a CSP meta replaced by another http-equiv", page('<meta http-equiv="set-cookie" content="a=b">', "")],
    ["an HTML comment hiding a tag after it", page("", "<!-- x --><script>x()</script>")],
    ["a tag name with a hyphen (custom element)", page("", "<x-evil onclick=x()></x-evil>")],
    ["a CDATA-ish tag", page("", "<math><mi>x</mi></math>")],
    ["a handler hidden after a > inside a quoted value", page("", '<div title=">" onclick="x()">x</div>')],
    ["a src hidden after a > inside a quoted value", page("", '<img alt=">" src="http://evil.example/x.png">')],
    ["an @import in a style tag with attributes", page('<style media="all">@import url(http://evil.example/x.css);</style>', "")],
    ["image-set with a bare string", page('<style>.a{background:image-set("http://evil.example/x.png" 1x)}</style>', "")],
    ["image-set with a single-quoted string", page("<style>.a{background:image-set('http://evil.example/x.png' 1x)}</style>", "")],
    ["-webkit-image-set", page('<style>.a{background:-webkit-image-set("http://evil.example/x.png" 1x)}</style>', "")],
    ["image-set in a style attribute", page("", `<div style="background:image-set('http://evil.example/x.png' 1x)">x</div>`)],
    ["IMAGE-SET in capitals", page('<style>.a{background:IMAGE-SET("http://evil.example/x.png" 1x)}</style>', "")],
    ["image-set with a comment before the parenthesis", page('<style>.a{background:image-set /**/ ("http://evil.example/x.png" 1x)}</style>', "")],
    ["image-set with a comment inside the name", page('<style>.a{background:image/**/-set("http://evil.example/x.png" 1x)}</style>', "")],
    ["image-set with a newline before the parenthesis", page('<style>.a{background:image-set\n("http://evil.example/x.png" 1x)}</style>', "")],
    ["a CSS-escaped image-set", page('<style>.a{background:\\69mage-set("http://evil.example/x.png" 1x)}</style>', "")],
    ["a CSS-escaped hyphen in image-set", page('<style>.a{background:image\\2d set("http://evil.example/x.png" 1x)}</style>', "")],
    ["src()", page('<style>.a{background:src("http://evil.example/x.png")}</style>', "")],
    ["image()", page('<style>.a{background:image("http://evil.example/x.png")}</style>', "")],
    ["cross-fade()", page('<style>.a{background:cross-fade("http://evil.example/x.png", red)}</style>', "")],
    ["-webkit-cross-fade()", page('<style>.a{background:-webkit-cross-fade("http://evil.example/x.png", red)}</style>', "")],
    ["element()", page("<style>.a{background:element(#x)}</style>", "")],
    ["-moz-element()", page("<style>.a{background:-moz-element(#x)}</style>", "")],
    ["paint()", page("<style>.a{background:paint(evil)}</style>", "")],
    ["attr()", page("<style>.a{background:attr(data-x url)}</style>", "")],
    ["a CSS function in a style attribute with capitals", page("", '<div style="background:Cross-Fade(red, blue)">x</div>')],
    ["an HTML entity hiding CSS in a style attribute", page("", '<div style="background:&#117;rl(http://evil.example/x)">x</div>')],
    ["an unterminated CSS comment hiding a function", page("<style>.a{background:image-set(/*</style>", "")],
    // Comment tricks: a "/*" inside a url token or string is not a comment to the browser.
    ["a comment opener inside a url token (style attribute)", page("", `<div style="a:url(${PIXEL}/*);background:url(${EVIL});b:url(*/)">x</div>`)],
    ["a comment opener inside a url token (style block)", page(`<style>.a{a:url(${PIXEL}/*);background:url(${EVIL});b:url(*/)}</style>`, "")],
    ["a comment opener inside a string", page(`<style>.a::before{content:"/*"}.b{background:url(${EVIL})}.c::before{content:"*/"}</style>`, "")],
    ["a harmless-looking comment", page("<style>/* note */.a{color:red}</style>", "")],
    ["a comment in a style attribute", page("", '<div style="color:red/**/">x</div>')],
    // url() scanner gaps
    ["U+2028 inside a quoted url", page(`<style>.a{background:url("${EVIL}${LS}b")}</style>`, "")],
    ["U+2028 inside an unquoted url", page("", `<div style="background:url(${EVIL}${LS}b)">x</div>`)],
    ["U+2029 inside an unquoted url", page(`<style>.a{background:url(${EVIL}${PS}b)}</style>`, "")],
    ["an unterminated url at the end of a style attribute", page("", `<div style="color:red;background:url(${EVIL}">x</div>`)],
    ["an unterminated url at the end of a style block", page(`<style>.a{background:url(${EVIL}</style>`, "")],
    ["an unterminated quoted url", page("", `<div style="background:url('${EVIL}'">x</div>`)],
    ["a no-break space before a data url", page(`<style>.a{background:url(${NBSP}${PIXEL})}</style>`, "")],
    ["a fragment reference (the renderer uses none)", page("<style>.a{filter:url(#x)}</style>", "")],
    ["a url with an empty argument", page("<style>.a{background:url()}</style>", "")],
    ["a url with a data URI followed by more text", page(`<style>.a{background:url(${PIXEL} ${EVIL})}</style>`, "")],
    ["a url hidden after a valid one", page(`<style>.a{background:url(${PIXEL}),url(${EVIL})}</style>`, "")],
    ["a url with whitespace before the parenthesis and an external target", page(`<style>.a{background:url\n(${EVIL})}</style>`, "")],
    // HTML parsing differentials
    ["a style tag closed with a slash", page(`<style/>.a{background:url(${EVIL})}</style>`, "")],
    ["an unquoted style value containing =", page("", `<div style=a=b;background:url(${EVIL})>x</div>`)],
    ["an unquoted onclick value containing quotes", page("", "<div title=a'b onclick=x()>x</div>")],
    ["a script hidden inside what looks like a quoted value", page("", "<div title=a'><script>alert(1)</script>'>x</div>")],
    ["an unterminated style element", page(`<style>.a{color:red}`, "")],
    ["an unterminated tag", page("", '<div title="x')],
    ["a stray less-than sign", page("", "<p>1 < 2</p>")],
    ["a processing instruction", page("", "<?xml version='1.0'?>")],
    ["a script with a huge attribute value", page("", `<script data-x="${"a".repeat(200_000)}"></script>`)],
  ])("rejects hostile input: %s", (_label, doc) => {
    expect(checkSelfContained(doc).ok).toBe(false);
  });

  it("names the comment rule", () => {
    expect(checkSelfContained(page("<style>/* x */</style>", ""))).toEqual({ ok: false, reason: "CSS comments are not allowed" });
  });

  it("scans in linear time on adversarial input", () => {
    const wrap = (head: string, body = "") => page(head, body);
    const inputs: [string, string][] = [
      ["url( x 40000", wrap(`<style>${"a{b:url(".repeat(40_000)}</style>`)],
      ["<p x 40000 then >", wrap("", "<p".repeat(40_000) + ">")],
      ["<style> x 40000", wrap("<style>".repeat(40_000))],
      ["<style> x 40000 then close", wrap("<style>".repeat(40_000) + "</style>")],
      ['<p a=" x 40000', wrap("", '<p a="'.repeat(40_000))],
      ["<p a='>' x 40000", wrap("", "<p a='>'>".repeat(40_000))],
      ["url(data) x 40000", wrap(`<style>${`a{b:url(${PIXEL})}`.repeat(4_000)}</style>`)],
      ["image-set + 1M spaces", wrap(`<style>.a{b:image-set${" ".repeat(1_000_000)}}</style>`)],
      ["url + 1M spaces", wrap(`<style>.a{b:url${" ".repeat(1_000_000)}}</style>`)],
    ];
    for (const [label, doc] of inputs) {
      const started = performance.now();
      checkSelfContained(doc);
      const elapsed = performance.now() - started;
      expect(elapsed, `${label} took ${elapsed.toFixed(0)} ms`).toBeLessThan(500);
    }
  });

  it("refuses a document with more than 200,000 tags before scanning them", () => {
    expect(MAX_TAG_STARTS).toBe(200_000);
    const many = page("", "<br>".repeat(MAX_TAG_STARTS));
    expect(checkSelfContained(many)).toEqual({ ok: false, reason: "document has too many tags" });
  });

  it("handles a very large clean document without hanging", () => {
    const body = "<p>x</p>".repeat(50_000);
    expect(checkSelfContained(page("", body))).toEqual({ ok: true });
  });

  it("still accepts the CSS the renderer legitimately uses", () => {
    const css =
      `@page{size:A4;margin:0}@font-face{font-family:"X";src:url(${FONT}) format('woff2')}` +
      `body{font-family:"X",sans-serif;background-image:url(${PIXEL});list-style-image:none}.v{unicode-bidi:isolate}`;
    const body = `<div style="width:10mm;margin:0 auto;background:url(${PIXEL})">x</div>`;
    expect(checkSelfContained(page(`<style>${css}</style>`, body))).toEqual({ ok: true });
  });

  it("names the CSS function it refused", () => {
    const result = checkSelfContained(page('<style>.a{background:image-set("x" 1x)}</style>', ""));
    expect(result).toEqual({ ok: false, reason: "CSS function image-set() is not allowed" });
  });

  it("refuses a document over the size cap before scanning it", () => {
    expect(MAX_DOCUMENT_CHARS).toBe(4 * 1024 * 1024);
    const filler = "<p>x</p>".repeat(MAX_DOCUMENT_CHARS / 8 + 1);
    expect(checkSelfContained(page("", filler))).toEqual({ ok: false, reason: "document is too large" });
    const atCap = page("", "").length;
    expect(checkSelfContained(page("", "x".repeat(MAX_DOCUMENT_CHARS - atCap)))).toEqual({ ok: true });
    expect(checkSelfContained(page("", "x".repeat(MAX_DOCUMENT_CHARS - atCap + 1))).ok).toBe(false);
  });

  it("does not blow up on many unterminated quotes", () => {
    const started = Date.now();
    const result = checkSelfContained(page("", '<div a="'.repeat(5_000)));
    expect(result.ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("accepts RTL and Devanagari text that was escaped by the builder", () => {
    const text = "\u202Eevil\u202C &lt;b&gt; आशा مرحبا";
    expect(Array.from("\u202Eevil\u202C")).toHaveLength(6);
    expect(checkSelfContained(page("", `<p><span class="v">${text}</span></p>`))).toEqual({ ok: true });
  });
});
