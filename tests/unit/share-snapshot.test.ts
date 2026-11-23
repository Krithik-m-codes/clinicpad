import { describe, expect, it } from "vitest";
import { hasFinalSnapshot } from "@/server/services/share-link-core";

describe("hasFinalSnapshot", () => {
  it("accepts a finalized or amended row that holds a snapshot", () => {
    expect(hasFinalSnapshot("finalized", { v: 1 })).toBe(true);
    expect(hasFinalSnapshot("amended", { v: 1 })).toBe(true);
  });

  it("refuses a row with no snapshot, and a draft whatever it holds", () => {
    expect(hasFinalSnapshot("finalized", null)).toBe(false);
    expect(hasFinalSnapshot("finalized", undefined)).toBe(false);
    expect(hasFinalSnapshot("draft", { v: 1 })).toBe(false);
  });
});
