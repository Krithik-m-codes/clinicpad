import { describe, expect, it } from "vitest";
import { catalogueKey, clampLimit, escapeLike, searchTerm } from "@/lib/domain/search";

describe("escapeLike", () => {
  it("escapes LIKE wildcards and the escape character", () => {
    expect(escapeLike("100%")).toBe("100\\%");
    expect(escapeLike("a_b")).toBe("a\\_b");
    expect(escapeLike("back\\slash")).toBe("back\\\\slash");
    expect(escapeLike("plain")).toBe("plain");
  });
});

describe("catalogueKey", () => {
  it("ignores case and spacing but keeps punctuation", () => {
    expect(catalogueKey("  DOLO   650MG ")).toBe("dolo 650mg");
    expect(catalogueKey("CTD T 12.5/20")).not.toBe(catalogueKey("CTD T 125/20"));
  });

  it("treats canonically equivalent Devanagari as the same name", () => {
    expect([..."\u0915\u093c"]).toHaveLength(2);
    expect(catalogueKey("\u0958")).toBe(catalogueKey("\u0915\u093c"));
  });
});

describe("searchTerm", () => {
  it("trims and collapses whitespace", () => {
    expect(searchTerm("  dolo   650 ")).toBe("dolo 650");
  });

  it("returns an empty string for non-strings and blanks", () => {
    expect(searchTerm(undefined)).toBe("");
    expect(searchTerm(42)).toBe("");
    expect(searchTerm("   ")).toBe("");
  });

  it("caps the length in characters without splitting emoji", () => {
    expect(searchTerm("x".repeat(500))).toHaveLength(60);
    const emoji = searchTerm("😀".repeat(100));
    expect(Array.from(emoji)).toHaveLength(60);
    expect(emoji).toBe("😀".repeat(60));
  });

  it("drops control characters such as NUL", () => {
    expect(searchTerm("do\u0000lo")).toBe("dolo");
  });
});

describe("clampLimit", () => {
  it.each([
    [undefined, 20],
    ["abc", 20],
    [Number.NaN, 20],
    [7, 7],
    ["7", 7],
    [7.9, 7],
    [0, 1],
    [-5, 1],
    [100000, 50],
  ])("clamps %j to %i", (raw, expected) => {
    expect(clampLimit(raw, 20, 50)).toBe(expected);
  });
});
