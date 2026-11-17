import { describe, expect, it } from "vitest";
import { FOOD_RELATION_LABELS_HI, FOOD_RELATIONS, PERIODICITIES, PERIODICITY_LABELS_HI } from "@/lib/domain/rx-options";
import { foodText, periodicityText } from "@/lib/rx-render/labels";

const devanagari = /\p{Script=Devanagari}/u;

describe("Hindi labels for the option codes (one source, NEEDS NATIVE-SPEAKER REVIEW)", () => {
  it.each(FOOD_RELATIONS.map((code) => [code]))("food relation %s has a Devanagari label that the pad prints", (code) => {
    expect(FOOD_RELATION_LABELS_HI[code]).toMatch(devanagari);
    expect(foodText(code, "hi")).toBe(FOOD_RELATION_LABELS_HI[code]);
  });

  it.each(PERIODICITIES.map((code) => [code]))("periodicity %s has a Devanagari label that the pad prints", (code) => {
    expect(PERIODICITY_LABELS_HI[code]).toMatch(devanagari);
    expect(periodicityText(code, "hi")).toBe(PERIODICITY_LABELS_HI[code]);
  });
});
