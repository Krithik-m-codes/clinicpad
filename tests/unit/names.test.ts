import { describe, expect, it } from "vitest";
import { nameKey, sameName } from "@/lib/domain/names";

describe("nameKey", () => {
  it("lowercases, collapses whitespace, and drops punctuation", () => {
    expect(nameKey("  Asha   RAO ")).toBe("asha rao");
    expect(nameKey("Asha-Rao")).toBe("asha rao");
  });

  it("drops a leading honorific", () => {
    expect(nameKey("Mrs. Asha Rao")).toBe("asha rao");
    expect(nameKey("Dr Ravi Sharma")).toBe("ravi sharma");
  });

  it("keeps Devanagari letters and combining marks intact", () => {
    expect(nameKey("आशा राव")).toBe("आशा राव");
  });

  it("does not turn a name that is only an honorific into an empty key", () => {
    expect(nameKey("Baby")).toBe("baby");
  });

  it("does not split a word on a zero-width non-joiner", () => {
    expect(nameKey("क्\u200cष")).toBe(nameKey("क्ष"));
  });

  it("does not split a word on a soft hyphen", () => {
    expect(nameKey("Ra\u00advi")).toBe("ravi");
  });
});

describe("sameName", () => {
  it("matches across casing and honorifics", () => {
    expect(sameName("Mr. Ravi Sharma", "ravi sharma")).toBe(true);
  });
  it("does not match different people", () => {
    expect(sameName("Ravi Sharma", "Ravi Sharma Jr")).toBe(false);
  });
  it("matches Devanagari names that differ only by a zero-width non-joiner", () => {
    expect(sameName("क्\u200cषमा", "क्षमा")).toBe(true);
  });
  it("never matches two names whose keys are empty", () => {
    expect(sameName("--", "..")).toBe(false);
    expect(sameName("", "")).toBe(false);
  });
});
