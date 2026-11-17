import { describe, expect, it } from "vitest";
import { checkSelfContained } from "@/lib/rx-render/self-contained";

const PIXEL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const FONT = "data:font/woff2;base64,d09GMgABAAAAAAA=";

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
    ["an unterminated tag", page("", '<div title="x')],
    ["a stray less-than sign", page("", "<p>1 < 2</p>")],
    ["a processing instruction", page("", "<?xml version='1.0'?>")],
    ["a script with a huge attribute value", page("", `<script data-x="${"a".repeat(200_000)}"></script>`)],
  ])("rejects hostile input: %s", (_label, doc) => {
    expect(checkSelfContained(doc).ok).toBe(false);
  });

  it("handles a very large clean document without hanging", () => {
    const body = "<p>x</p>".repeat(100_000);
    expect(checkSelfContained(page("", body))).toEqual({ ok: true });
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
