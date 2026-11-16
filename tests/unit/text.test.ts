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

  it("does not trim", () => {
    expect(cleanText("  padded  ")).toBe("  padded  ");
  });
});
