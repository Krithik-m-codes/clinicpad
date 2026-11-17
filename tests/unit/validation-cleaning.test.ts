import { describe, expect, it } from "vitest";
import { catalogueKey } from "@/lib/domain/search";
import { cleanText } from "@/lib/domain/text";
import { patientInputSchema } from "@/server/validation/patient";
import { amendReasonSchema } from "@/server/validation/prescription";

describe("cleanText invisible characters (final fix wave)", () => {
  it.each([
    ["left-to-right mark", "\u200e"],
    ["right-to-left mark", "\u200f"],
    ["Arabic letter mark", "\u061c"],
    ["invisible function application", "\u2061"],
    ["invisible times", "\u2062"],
    ["invisible separator", "\u2063"],
    ["invisible plus", "\u2064"],
    ["Mongolian vowel separator", "\u180e"],
  ])("removes the %s", (_name, ch) => {
    expect([...ch]).toHaveLength(1);
    expect(cleanText(`Dolo${ch} 650`)).toBe("Dolo 650");
    expect(catalogueKey(`Dolo${ch} 650`)).toBe(catalogueKey("Dolo 650"));
  });

  it("removes Unicode tag characters (astral code points, not code units)", () => {
    const tagA = String.fromCodePoint(0xe0041);
    const cancel = String.fromCodePoint(0xe007f);
    const first = String.fromCodePoint(0xe0000);
    expect(tagA).toHaveLength(2);
    expect([...tagA]).toHaveLength(1);
    const input = `Dolo${tagA}${cancel}${first} 650`;
    expect([...input]).toHaveLength(11);
    expect(cleanText(input)).toBe("Dolo 650");
    expect(cleanText(`a${String.fromCodePoint(0xe0080)}b`)).toBe(`a${String.fromCodePoint(0xe0080)}b`);
  });

  it("still keeps ZWJ and ZWNJ", () => {
    expect(cleanText("\u0915\u094d\u200d\u0937")).toBe("\u0915\u094d\u200d\u0937");
    expect(cleanText("\u0915\u094d\u200c\u0937")).toBe("\u0915\u094d\u200c\u0937");
  });
});

describe("amendReasonSchema cleaning", () => {
  it("removes invisible and control characters before measuring", () => {
    expect(amendReasonSchema.safeParse("Wrong\u200e dose\u202e given\r\n").data).toBe("Wrong dose given");
    // Five invisible characters plus two letters is not a reason of five characters.
    const padded = "a\u200b\u200e\u200f\u2061b\u2062\u2063";
    expect([...padded]).toHaveLength(8);
    const result = amendReasonSchema.safeParse(padded);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0].message).toBe("Give a reason of at least 5 characters");
  });

  it("keeps its messages and still refuses a NUL instead of dropping it", () => {
    expect(amendReasonSchema.safeParse("abcd").error?.issues[0].message).toBe("Give a reason of at least 5 characters");
    expect(amendReasonSchema.safeParse("x".repeat(501)).error?.issues[0].message).toBe("Keep the reason under 500 characters");
    expect(amendReasonSchema.safeParse("valid\u0000reason").error?.issues[0].message).toBe("Text contains an invalid character");
  });
});

describe("patient text cleaning", () => {
  it("removes invisible and bidi characters from every text field, keeping the NUL guard", () => {
    const parsed = patientInputSchema.safeParse({
      name: "Asha\u200e Rao\u202e",
      phone: "98765\u200b43210",
      address: "12 Main\u2061 Road",
      notes: "Note\u200f one",
      allergies: ["Penicil\u200blin", "Sul\u2062fa"],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.name).toBe("Asha Rao");
      expect(parsed.data.phone).toBe("9876543210");
      expect(parsed.data.address).toBe("12 Main Road");
      expect(parsed.data.notes).toBe("Note one");
      expect(parsed.data.allergies).toEqual(["Penicillin", "Sulfa"]);
    }
    expect(patientInputSchema.safeParse({ name: "Asha\u0000 Rao" }).success).toBe(false);
  });

  it("cleans a comma separated allergy string too", () => {
    const parsed = patientInputSchema.safeParse({ name: "Asha Rao", allergies: "Penicil\u200blin, Sul\u200efa" });
    expect(parsed.success && parsed.data.allergies).toEqual(["Penicillin", "Sulfa"]);
  });
});
