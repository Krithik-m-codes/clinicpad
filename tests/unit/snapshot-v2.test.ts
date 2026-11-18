import { describe, expect, it } from "vitest";
import { renderPrescription } from "@/lib/rx-render/render";
import { parseRenderSnapshot, renderSnapshotSchema } from "@/lib/rx-render/snapshot";
import { snapshot } from "../fixtures/rx-documents";
import { OVERLAY_HASH, OVERLAY_VERSION_ID, overlayDocument, overlayInput } from "../fixtures/overlay-documents";

const overlayRef = { kind: "overlay" as const, templateVersionId: OVERLAY_VERSION_ID, contentSha256: OVERLAY_HASH };
const NO_ASSETS = { logo: null, signature: null, fontCss: "" };

describe("render snapshot versions", () => {
  it("keeps version 1 for built-in pads, byte for byte (everything finalized before Plan 2A reads unchanged)", () => {
    const v1 = snapshot();
    expect(v1.v).toBe(1);
    expect(parseRenderSnapshot(v1)).toEqual(v1);
    expect(renderSnapshotSchema.parse(v1).v).toBe(1);
  });

  it("writes version 2 only for an overlay pad, with its version id and content hash", () => {
    const v2 = snapshot({ layout: { template: overlayRef } });
    expect(v2.v).toBe(2);
    expect(parseRenderSnapshot(v2)?.layout.template).toEqual(overlayRef);
    expect(renderSnapshotSchema.parse(v2).v).toBe(2);
  });

  it.each([
    ["an overlay reference inside a v1 snapshot", { ...snapshot({ layout: { template: overlayRef } }), v: 1 }],
    ["a built-in reference inside a v2 snapshot", { ...snapshot(), v: 2 }],
    ["a malformed content hash", { ...snapshot({ layout: { template: overlayRef } }), layout: { template: { ...overlayRef, contentSha256: "XYZ" }, paperSize: "A4", labels: "en" } }],
    ["a missing version id", { ...snapshot({ layout: { template: overlayRef } }), layout: { template: { kind: "overlay", contentSha256: OVERLAY_HASH }, paperSize: "A4", labels: "en" } }],
    ["a DOCX reference (2B)", { ...snapshot({ layout: { template: overlayRef } }), layout: { template: { ...overlayRef, kind: "docx" }, paperSize: "A4", labels: "en" } }],
    ["version 3", { ...snapshot(), v: 3 }],
  ])("refuses %s", (_label, value) => {
    expect(parseRenderSnapshot(value)).toBeNull();
  });
});

describe("renderPrescription dispatch", () => {
  it("draws an overlay document only with its own loaded template", () => {
    const doc = overlayDocument();
    expect(renderPrescription(doc, { ...NO_ASSETS, overlay: overlayInput() }).html).toContain('<table class="flow">');
    expect(() => renderPrescription(doc, NO_ASSETS)).toThrow(/not loaded/);
    expect(() => renderPrescription(doc, { ...NO_ASSETS, overlay: { ...overlayInput(), templateVersionId: "019a5c00-0000-7000-8000-00000000ffff" } })).toThrow(/not loaded/);
  });
});
