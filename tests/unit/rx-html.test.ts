import { describe, expect, it } from "vitest";
import { escapeHtml, html, raw, userText } from "@/lib/rx-render/html";

describe("html tagged template", () => {
  it("escapes every interpolated string", () => {
    expect(html`<p>${`<b>&'"`}</p>`.value).toBe("<p>&lt;b&gt;&amp;&#39;&quot;</p>");
  });

  it("inserts SafeHtml as-is, joins arrays, prints numbers, and drops empty values", () => {
    const items = ["a<", "b"].map((v) => html`<li>${v}</li>`);
    expect(html`<ul>${items}</ul>${null}${undefined}${false}${0}`.value).toBe("<ul><li>a&lt;</li><li>b</li></ul>0");
  });

  it("passes raw markup through untouched", () => {
    expect(html`<div>${raw("<br>")}</div>`.value).toBe("<div><br></div>");
  });

  it.each([
    ["a script tag", "<script>alert(1)</script>"],
    ["an attribute breakout", '" onmouseover="alert(1)'],
    ["a single-quote breakout", "' onfocus='alert(1)"],
    ["a javascript URL", "javascript:alert(1)"],
    ["a CSS injection", "red;background:url(http://evil.example/x)"],
    ["a closing style tag", "</style><script>x()</script>"],
    ["an entity smuggle", "&lt;script&gt;"],
  ])("never lets %s produce a live tag or quote", (_label, evil) => {
    const out = html`<p title="${evil}">${evil}</p>`.value;
    // Only the template's own markup may contain these characters: 2 tags, 2 quotes, 0 apostrophes.
    expect(out.match(/</g)).toHaveLength(2);
    expect(out.match(/>/g)).toHaveLength(2);
    expect(out.match(/"/g)).toHaveLength(2);
    expect(out).not.toContain("'");
    const escaped = out.slice('<p title="'.length, out.indexOf('">'));
    expect(out).toBe(`<p title="${escaped}">${escaped}</p>`);
  });

  describe("interpolation positions", () => {
    const evil = "16 onerror=alert(1)";

    it.each([
      ["an unquoted attribute value", () => html`<img width=${evil}>`],
      ["an unquoted attribute value after whitespace", () => html`<img width= ${evil}>`],
      ["an unquoted class value", () => html`<div class=${"a style=color:red"}>x</div>`],
      ["an attribute name", () => html`<div ${evil}>x</div>`],
      ["a position between attributes", () => html`<div a="1" ${evil}>x</div>`],
      ["a position right after a closing quote", () => html`<div a="1"${evil}>x</div>`],
      ["a tag name", () => html`<${"script"}>x</script>`],
      ["a closing tag name", () => html`<div>x</${"div"}>`],
      ["a tag name after a slash", () => html`<br/${evil}>`],
      ["SafeHtml inside a quoted attribute", () => html`<p title="${raw("<b>")}">x</p>`],
      ["an array holding SafeHtml inside a quoted attribute", () => html`<p title="${[html`a`]}">x</p>`],
      ["a number in an unquoted attribute", () => html`<td colspan=${2}>x</td>`],
      ["null in an attribute-name position (still a template bug)", () => html`<div ${null}>x</div>`],
    ])("refuses %s", (_label, build) => {
      expect(build).toThrow(/html template/);
    });

    it("refuses a template that ends inside a tag", () => {
      expect(() => html`<div class="a"`).toThrow(/ends inside a tag/);
      expect(() => html`<div title="open`).toThrow(/ends inside a tag/);
    });

    it("allows element text, double-quoted and single-quoted attribute values", () => {
      expect(html`<p>${"a<"}</p>`.value).toBe("<p>a&lt;</p>");
      expect(html`<p title="${'x" y'}">t</p>`.value).toBe('<p title="x&quot; y">t</p>');
      expect(html`<p title='${"x' y"}'>t</p>`.value).toBe("<p title='x&#39; y'>t</p>");
      expect(html`<td colspan="${2}" class="a ${"b"} c">x</td>`.value).toBe('<td colspan="2" class="a b c">x</td>');
    });

    it("allows nested SafeHtml and arrays in text, and a bare less-than sign in text", () => {
      const cell = (v: string) => html`<td title="${v}">${v}</td>`;
      const row = html`<tr>${[cell("a<"), [cell("b")], null, false]}</tr>`;
      expect(row.value).toBe('<tr><td title="a&lt;">a&lt;</td><td title="b">b</td></tr>');
      expect(html`<p>1 < ${2} and ${"3"} > 0</p>`.value).toBe("<p>1 < 2 and 3 > 0</p>");
      expect(html`<table>${html`<tr>${html`<td>${"x"}</td>`}</tr>`}</table>`.value).toBe("<table><tr><td>x</td></tr></table>");
    });
  });

  it("does not double-process escaped output or re-escape SafeHtml", () => {
    const once = html`${"<"}`;
    expect(html`${once}`.value).toBe("&lt;");
    expect(html`${"&lt;"}`.value).toBe("&amp;lt;");
  });

  it("handles nested arrays and very large input", () => {
    const nested = [["<", [html`<b>`]], "&"];
    expect(html`${nested}`.value).toBe("&lt;<b>&amp;");
    const big = "<".repeat(200_000);
    expect(html`${big}`.value).toBe("&lt;".repeat(200_000));
  });
});

describe("escapeHtml", () => {
  it("removes control characters but keeps tab, LF, and CR", () => {
    const input = "a\u0000b\u0007c\u001bd\te\nf\rg\u007f";
    expect(input.codePointAt(1)).toBe(0x0000);
    expect(input.codePointAt(3)).toBe(0x0007);
    expect(escapeHtml(input)).toBe("abcd\te\nf\rg");
  });

  it("cannot rebuild a tag from a control character placed inside it", () => {
    const input = "<scr\u0000ipt>";
    expect(input).toHaveLength(9);
    expect(escapeHtml(input)).toBe("&lt;script&gt;");
  });
});

describe("userText", () => {
  it("escapes, isolates for bidi, and keeps line breaks", () => {
    expect(userText("<i>one</i>\r\ntwo\nthree\u2028four").value).toBe(
      '<span class="v">&lt;i&gt;one&lt;/i&gt;<br>two<br>three<br>four</span>',
    );
    expect("x\u2028y".codePointAt(1)).toBe(0x2028);
  });

  it("is empty for blank, null, and undefined", () => {
    expect(userText("   ").value).toBe("");
    expect(userText(null).value).toBe("");
    expect(userText(undefined).value).toBe("");
  });

  it("keeps Devanagari and a right-to-left override as text", () => {
    const rlo = "\u202Eevil\u202C";
    expect(Array.from(rlo)).toHaveLength(6);
    expect(userText(`आशा ${rlo}`).value).toBe(`<span class="v">आशा ${rlo}</span>`);
  });

  it("turns a lone CR and U+2029 into line breaks and escapes markup in hostile text", () => {
    expect(userText("a\rb\u2029c").value).toBe('<span class="v">a<br>b<br>c</span>');
    expect("x\u2029y".codePointAt(1)).toBe(0x2029);
    const out = userText('"><img src=x onerror=alert(1)>').value;
    expect(out).toBe('<span class="v">&quot;&gt;&lt;img src=x onerror=alert(1)&gt;</span>');
    expect(out.slice('<span class="v">'.length, -"</span>".length)).not.toMatch(/[<>]/);
  });

  it("handles a very large value", () => {
    const out = userText("a<\n".repeat(50_000)).value;
    expect(out.startsWith('<span class="v">')).toBe(true);
    expect(out.split("<br>")).toHaveLength(50_001);
  });
});
