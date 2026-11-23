import { describe, expect, it } from "vitest";
import { overlayDefinitionSchema } from "@/lib/rx-render/overlay-definition";
import { renderOverlay } from "@/lib/rx-render/overlay";
import { templateContentSha256 } from "@/server/templates/content-hash";
import { MINIMAL_OVERLAY_DEFINITION } from "../fixtures/overlay-definitions";
import { overlayDefinition, overlayDocument, overlayInput } from "../fixtures/overlay-documents";

const assets = { logo: null, signature: null, fontCss: "" };
const render = (offset: { x: number; y: number }, target: "print" | "pdf" | "screen", printMode: "always" | "pdf_only" = "pdf_only") =>
  renderOverlay(overlayDocument(), assets, overlayInput(overlayDefinition({ printOffsetMm: offset, background: { printMode } })), { target, sample: false }).html;

describe("pre-printed paper and the printer offset", () => {
  it("prints the data only on paper (no background) and keeps the background in the PDF and on screen", () => {
    expect(render({ x: 0, y: 0 }, "print")).not.toContain('class="bg"');
    expect(render({ x: 0, y: 0 }, "pdf")).toContain('class="bg"');
    expect(render({ x: 0, y: 0 }, "screen")).toContain('class="bg"');
    expect(render({ x: 0, y: 0 }, "print", "always")).toContain('class="bg"');
  });

  it("applies the offset to paper only: the same box lands 2 mm right and 1.5 mm up on paper, nowhere else", () => {
    const box = (html: string) => /\.box-0\{left:[\d.]+mm;top:[\d.]+mm/.exec(html)?.[0];
    const base = box(render({ x: 0, y: 0 }, "print"));
    expect(base).toBeDefined();
    expect(box(render({ x: 2, y: -1.5 }, "print"))).not.toBe(base);
    expect(box(render({ x: 2, y: -1.5 }, "pdf"))).toBe(box(render({ x: 0, y: 0 }, "pdf")));
    expect(box(render({ x: 2, y: -1.5 }, "screen"))).toBe(box(render({ x: 0, y: 0 }, "screen")));
  });

  it("reprints deterministically: the same pinned definition renders the same paper bytes every time", () => {
    expect(render({ x: 2, y: -1.5 }, "print")).toBe(render({ x: 2, y: -1.5 }, "print"));
  });

  it("clamps the spacer of a stored version whose offset pushes it past the engine limit instead of throwing", () => {
    const html = render({ x: 0, y: 10 }, "print");
    const top = /\.flow-top\{height:([\d.]+)mm\}/.exec(html);
    expect(top).not.toBeNull();
    expect(Number(top?.[1])).toBeLessThanOrEqual(70.9);
  });

  it("keeps the offset in the content hash of the version, so a recalibration is a new version and old prescriptions keep theirs", () => {
    const content = (x: number) => ({
      kind: "overlay" as const,
      paperSize: "A4" as const,
      labels: "en" as const,
      definition: overlayDefinitionSchema.parse({ ...MINIMAL_OVERLAY_DEFINITION, printOffsetMm: { x, y: 0 } }),
      fileSha256: "ab".repeat(32),
    });
    expect(templateContentSha256(content(0))).toBe("60e21a33f2a8896e24921a10af5f5f0e0d5ea20b468f5c865c774c45cf790b24");
    expect(templateContentSha256(content(1))).not.toBe(templateContentSha256(content(0)));
  });
});
