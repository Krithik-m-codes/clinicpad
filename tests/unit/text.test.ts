import { describe, expect, it } from "vitest";
import { cleanText } from "@/lib/domain/text";

describe("cleanText", () => {
  it("removes NUL and other control characters but keeps tabs and newlines", () => {
    expect(cleanText("a\u0000b\u0007c\u001bd\u007fe")).toBe("abcde");
    expect(cleanText("col1\tcol2\nnext")).toBe("col1\tcol2\nnext");
  });

  it("turns Windows and old Mac line endings into LF", () => {
    expect(cleanText("one\r\ntwo\rthree")).toBe("one\ntwo\nthree");
  });

  it("normalizes to NFC so the same Devanagari text compares equal", () => {
    // U+0958 (precomposed QA) and U+0915 U+093C (KA + nukta) render identically; written as escapes on purpose.
    const precomposed = "\u0958";
    const decomposed = "\u0915\u093c";
    expect([...precomposed]).toHaveLength(1);
    expect([...decomposed]).toHaveLength(2);
    expect(cleanText(precomposed)).toBe(cleanText(decomposed));
    expect(cleanText("आशा राव")).toBe("आशा राव");
  });

  it("leaves HTML-looking text alone (it is stored as plain text)", () => {
    expect(cleanText('<img src=x onerror="alert(1)">')).toBe('<img src=x onerror="alert(1)">');
  });

  it.each([
    ["zero-width space", "\u200b"],
    ["soft hyphen", "\u00ad"],
    ["byte order mark / zero-width no-break space", "\ufeff"],
    ["word joiner", "\u2060"],
    ["left-to-right embedding", "\u202a"],
    ["right-to-left embedding", "\u202b"],
    ["pop directional formatting", "\u202c"],
    ["left-to-right override", "\u202d"],
    ["right-to-left override", "\u202e"],
    ["left-to-right isolate", "\u2066"],
    ["right-to-left isolate", "\u2067"],
    ["first strong isolate", "\u2068"],
    ["pop directional isolate", "\u2069"],
    ["C1 control U+0080", "\u0080"],
    ["C1 control U+009F", "\u009f"],
  ])("removes the invisible character %s", (_name, invisible) => {
    expect([...invisible]).toHaveLength(1);
    const input = `a${invisible}b`;
    expect([...input]).toHaveLength(3);
    const result = cleanText(input);
    expect(result).toBe("ab");
    expect([...result]).toHaveLength(2);
  });

  it("removes every invisible character from one string", () => {
    const input = "a\u200bb\u00adc\ufeffd\u202ee";
    expect([...input]).toHaveLength(9);
    expect(cleanText(input)).toBe("abcde");
  });

  it("turns NEL, line separator, and paragraph separator into a line feed", () => {
    const input = "one\u0085two\u2028three\u2029four";
    expect([...input]).toHaveLength(18);
    expect(cleanText(input)).toBe("one\ntwo\nthree\nfour");
    expect(cleanText("x\r\u0085y")).toBe("x\ny");
  });

  it("keeps ZWJ and ZWNJ, which Devanagari conjuncts need", () => {
    const zwj = "\u0915\u094d\u200d\u0937";
    const zwnj = "\u0915\u094d\u200c\u0937";
    expect([...zwj]).toHaveLength(4);
    expect([...zwnj]).toHaveLength(4);
    expect(cleanText(zwj)).toBe(zwj);
    expect(cleanText(zwnj)).toBe(zwnj);
    expect([...cleanText(zwj)]).toHaveLength(4);
    expect([...cleanText(zwnj)]).toHaveLength(4);
    expect(cleanText(zwj)).not.toBe(cleanText(zwnj));
  });

  it.each([
    ["a lone high surrogate", "\ud800"],
    ["a lone low surrogate", "\udc00"],
  ])("removes %s, which Postgres jsonb cannot store", (_name, lone) => {
    expect(lone).toHaveLength(1);
    const input = `a${lone}b`;
    expect(input).toHaveLength(3);
    const result = cleanText(input);
    expect(result).toBe("ab");
    expect([...result]).toHaveLength(2);
  });

  it("removes a reversed surrogate pair (low then high) as two lone surrogates", () => {
    const input = "a\udc00\ud800b";
    expect(input).toHaveLength(4);
    expect(cleanText(input)).toBe("ab");
  });

  it("keeps valid surrogate pairs (emoji and other astral characters) unchanged", () => {
    const emoji = "😀";
    expect(emoji).toHaveLength(2);
    expect([...emoji]).toHaveLength(1);
    const input = `a${emoji}b𝐀c`;
    expect(cleanText(input)).toBe(input);
    expect([...cleanText(input)]).toHaveLength(5);
    // A lone surrogate next to a valid pair does not damage the pair.
    expect(cleanText(`\ud800${emoji}`)).toBe(emoji);
    expect(cleanText(`${emoji}\udc00`)).toBe(emoji);
  });

  it("does not trim", () => {
    expect(cleanText("  padded  ")).toBe("  padded  ");
  });
});
