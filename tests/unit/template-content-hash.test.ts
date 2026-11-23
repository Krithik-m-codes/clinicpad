import { describe, expect, it } from "vitest";
import { overlayDefinitionSchema } from "@/lib/rx-render/overlay-definition";
import { templateContentSha256 } from "@/server/templates/content-hash";
import { MINIMAL_OVERLAY_DEFINITION } from "../fixtures/overlay-definitions";

const content = () => ({
  kind: "overlay" as const,
  paperSize: "A4" as const,
  labels: "en" as const,
  definition: overlayDefinitionSchema.parse(MINIMAL_OVERLAY_DEFINITION),
  fileSha256: "ab".repeat(32),
});

describe("templateContentSha256 (frozen with overlay v1, ADR-0045)", () => {
  it("is pinned to a literal for fixed content: a change here orphans every finalized custom-pad prescription", () => {
    expect(templateContentSha256(content())).toBe("60e21a33f2a8896e24921a10af5f5f0e0d5ea20b468f5c865c774c45cf790b24");
  });

  it("changes with each part of the content", () => {
    const base = templateContentSha256(content());
    const defn = content().definition;
    expect(templateContentSha256({ ...content(), paperSize: "A5" })).not.toBe(base);
    expect(templateContentSha256({ ...content(), labels: "hi" })).not.toBe(base);
    expect(templateContentSha256({ ...content(), fileSha256: "cd".repeat(32) })).not.toBe(base);
    expect(templateContentSha256({ ...content(), definition: { ...defn, flow: { ...defn.flow, topMm: 65 } } })).not.toBe(base);
  });

  it("does not depend on the key order of the stored definition", () => {
    const defn = content().definition;
    const reordered = Object.fromEntries(Object.entries(defn).reverse()) as typeof defn;
    expect(templateContentSha256({ ...content(), definition: reordered })).toBe(templateContentSha256(content()));
  });
});
