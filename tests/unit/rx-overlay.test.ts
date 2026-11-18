import { describe, expect, it } from "vitest";
import { EMPTY_FOOTER, renderOverlay, type OverlayRenderOptions } from "@/lib/rx-render/overlay";
import { overlayCss } from "@/lib/rx-render/overlay-css";
import type { OverlayBox } from "@/lib/rx-render/overlay-definition";
import { PAPER } from "@/lib/rx-render/paper";
import { checkSelfContained, MAX_DOCUMENT_CHARS } from "@/lib/rx-render/self-contained";
import { BACKGROUND_LIMITS, IMAGE_LIMITS } from "@/lib/domain/image";
import { loadFontCss } from "@/server/rx-render/fonts";
import type { RenderAssets, RenderTarget, RxDocument } from "@/lib/rx-render/types";
import { DEVANAGARI, HOSTILE, TINY_PNG, manyItems, snapshot } from "../fixtures/rx-documents";
import { a5Definition, overlayDefinition, overlayDocument, overlayInput } from "../fixtures/overlay-documents";

const NO_ASSETS: RenderAssets = { logo: null, signature: null, fontCss: "" };
const SCREEN: OverlayRenderOptions = { target: "screen", sample: false };
const parse = (markup: string) => new DOMParser().parseFromString(markup, "text/html");
const css = (markup: string) => parse(markup).querySelector("style")?.textContent ?? "";
const box = (patch: Partial<OverlayBox>): OverlayBox => ({ id: "x", field: "patient.name", xMm: 20, yMm: 30, wMm: 60, hMm: 7, fontPt: 10, align: "left", bold: false, repeat: "every_page", ...patch });

function render(doc: RxDocument = overlayDocument(), options: OverlayRenderOptions = SCREEN, input = overlayInput(), assets = NO_ASSETS) {
  return renderOverlay(doc, assets, input, options);
}

describe("renderOverlay", () => {
  it("is self-contained for every target, paper size and status", () => {
    for (const target of ["screen", "print", "pdf"] as RenderTarget[]) {
      for (const [doc, def] of [
        [overlayDocument(), overlayDefinition()],
        [overlayDocument({ layout: { paperSize: "A5", labels: "bilingual" }, items: manyItems(30) }), a5Definition()],
        [overlayDocument({ status: "draft", rxNo: null, issuedAt: null, snapshotSource: "live" }), overlayDefinition({ pageNumbers: { bandMm: 8 } })],
        [overlayDocument({ status: "amended", supersededBy: { version: 2, issuedAt: null } }), overlayDefinition()],
      ] as const) {
        const out = render(doc, { target, sample: target === "screen" }, overlayInput(def), { ...NO_ASSETS, logo: TINY_PNG, signature: TINY_PNG });
        expect(checkSelfContained(out.html)).toEqual({ ok: true });
        expect(checkSelfContained(out.footerHtml)).toEqual({ ok: true });
      }
    }
  });

  it("draws the background, the field boxes and the body region", () => {
    const page = parse(render().html);
    expect(page.querySelector(".bg img")?.getAttribute("src")).toMatch(/^data:image\/png;base64,/);
    expect(page.querySelectorAll(".box")).toHaveLength(2);
    expect(page.querySelector(".box-0")?.textContent).toBe("Asha Rao");
    expect(page.querySelector(".box-1")?.textContent).toBe("12/11/2026");
    expect(page.querySelector(".flow .flow-body")?.textContent).toContain("Medicine 1");
    expect(page.querySelector(".flow > thead .flow-top")).not.toBeNull();
    expect(page.querySelector(".flow > tfoot .flow-bottom")).not.toBeNull();
  });

  it("fixes every-page boxes and places first-page boxes once", () => {
    const def = overlayDefinition({ boxes: [box({ id: "a" }), box({ id: "b", field: "visit.rx_no", repeat: "first_page", yMm: 40 })] });
    const out = render(overlayDocument(), SCREEN, overlayInput(def));
    expect(css(out.html)).toContain(".box{position:fixed");
    expect(css(out.html)).toContain(".box-first{position:absolute}");
    expect(parse(out.html).querySelector(".box-1")?.className).toBe("box box-1 box-first");
  });

  it("omits the background only when printing on pre-printed paper", () => {
    const preprinted = overlayInput(overlayDefinition({ background: { printMode: "pdf_only" } }));
    expect(parse(render(overlayDocument(), { target: "print", sample: false }, preprinted).html).querySelector(".bg")).toBeNull();
    expect(parse(render(overlayDocument(), { target: "pdf", sample: false }, preprinted).html).querySelector(".bg")).not.toBeNull();
    expect(parse(render(overlayDocument(), SCREEN, preprinted).html).querySelector(".bg")).not.toBeNull();
    expect(parse(render(overlayDocument(), { target: "print", sample: false }).html).querySelector(".bg")).not.toBeNull();
  });

  it("applies the printer offset to paper only", () => {
    const input = overlayInput(overlayDefinition({ printOffsetMm: { x: 2, y: -1.5 } }));
    const printed = css(render(overlayDocument(), { target: "print", sample: false }, input).html);
    expect(printed).toContain(".box-0{left:22mm;top:50.5mm;");
    expect(printed).toContain(".flow-top{height:62.5mm}");
    const pdf = css(render(overlayDocument(), { target: "pdf", sample: false }, input).html);
    expect(pdf).toContain(".box-0{left:20mm;top:52mm;");
  });

  it("prints hostile text literally and in isolation, and never puts user text in CSS", () => {
    const doc = overlayDocument({ snapshot: snapshot({ patient: { name: `${HOSTILE.script}${HOSTILE.bidi}${HOSTILE.urls}` } }) });
    const out = render(doc);
    const page = parse(out.html);
    expect(page.querySelector("script")).toBeNull();
    expect(page.querySelector(".box-0 .v")?.textContent).toBe(`${HOSTILE.script}${HOSTILE.bidi}${HOSTILE.urls}`);
    expect(css(out.html)).not.toContain("evil.example");
    expect(css(out.html)).not.toContain("alert");
  });

  it("never clips: overflow stays visible and a 2,000-character word prints whole", () => {
    const out = render(overlayDocument({ snapshot: snapshot({ patient: { name: HOSTILE.longWord } }) }));
    expect(css(out.html)).toContain("overflow:visible");
    expect(parse(out.html).querySelector(".box-0")?.textContent).toBe(HOSTILE.longWord);
  });

  it("prints blanks as nothing, never 'undefined'", () => {
    const def = overlayDefinition({ boxes: [box({ id: "reg", field: "doctor.reg_no" }), box({ id: "fu", field: "follow_up.line", yMm: 40 })] });
    const doc = overlayDocument({ snapshot: snapshot({ doctor: { registrationNo: null } }), visit: { ...overlayDocument().visit, followUpDate: null, followUpReason: null } });
    const page = parse(render(doc, SCREEN, overlayInput(def)).html);
    expect(page.querySelector(".box-0")?.textContent).toBe("");
    expect(page.querySelector(".box-1")?.textContent).toBe("");
    expect(page.body.textContent).not.toMatch(/undefined|null/);
  });

  it("never prints a signature image or an Rx number on a draft", () => {
    const def = overlayDefinition({
      signature: { mode: "box" },
      boxes: [box({ id: "sig", field: "doctor.signature", yMm: 250, hMm: 15 }), box({ id: "rx", field: "visit.rx_no", yMm: 40 })],
    });
    const assets = { ...NO_ASSETS, signature: TINY_PNG };
    const draft = parse(render(overlayDocument({ status: "draft", issuedAt: null }), SCREEN, overlayInput(def), assets).html);
    expect(draft.querySelector(".box-0 img")).toBeNull();
    expect(draft.querySelector(".box-1")?.textContent).toBe("");
    expect(draft.querySelector(".watermark")?.textContent).toBe("DRAFT · NOT VALID FOR DISPENSING");
    const final = parse(render(overlayDocument(), SCREEN, overlayInput(def), assets).html);
    expect(final.querySelector(".box-0 img")).not.toBeNull();
    expect(final.querySelector(".box-1")?.textContent).toBe("12");
  });

  it("prints the signature block after the content unless the signature has its own box", () => {
    expect(parse(render().html).querySelector(".closing .sig")).not.toBeNull();
    const def = overlayDefinition({ signature: { mode: "box" }, boxes: [box({ id: "sig", field: "doctor.signature" })] });
    expect(parse(render(overlayDocument(), SCREEN, overlayInput(def)).html).querySelector(".sig")).toBeNull();
  });

  it("marks sample previews with a watermark and a solid banner in the body", () => {
    const page = parse(render(overlayDocument(), { target: "screen", sample: true }).html);
    expect(page.querySelector(".watermark")?.textContent).toBe("SAMPLE · NOT A PRESCRIPTION");
    expect(page.querySelector(".flow-body .banner-sample")?.textContent).toBe("SAMPLE · NOT A PRESCRIPTION");
    expect(css(render(overlayDocument(), { target: "screen", sample: true }).html)).toContain(".banner-sample{");
    expect(parse(render().html).querySelector(".banner-sample")).toBeNull();
  });

  it("never prints a signature image in a sample preview", () => {
    const def = overlayDefinition({ signature: { mode: "box" }, boxes: [box({ id: "sig", field: "doctor.signature" })] });
    const page = parse(render(overlayDocument(), { target: "screen", sample: true }, overlayInput(def), { ...NO_ASSETS, signature: TINY_PNG }).html);
    expect(page.querySelector(".box-0 img")).toBeNull();
  });

  it("keeps pre-line wrapping so multi-line address and footer boxes print their lines", () => {
    expect(css(render().html)).toContain("white-space:pre-line");
  });

  it("refuses a body region whose spacers the printer would not repeat (24% of the paper)", () => {
    const tall = overlayDefinition({ flow: { ...overlayDefinition().flow, topMm: 72 } });
    expect(() => render(overlayDocument(), SCREEN, overlayInput(tall))).toThrow(/spacer/);
    const ok = overlayDefinition({ flow: { ...overlayDefinition().flow, topMm: 71, bottomMm: 71 } });
    expect(() => render(overlayDocument(), SCREEN, overlayInput(ok))).not.toThrow();
  });

  it("fits the worst case under the document cap: biggest background, logo and signature boxes, 30 medicines, 5,000-character hostile fields", () => {
    const filler = (bytes: number) => "A".repeat(Math.ceil((bytes * 4) / 3 / 4) * 4);
    const bg = { mime: "image/jpeg" as const, base64: filler(BACKGROUND_LIMITS.maxBytes), width: 1654, height: 2339 };
    const big = (bytes: number) => ({ mime: "image/png" as const, base64: filler(bytes), width: 400, height: 200 });
    const def = overlayDefinition({
      signature: { mode: "box" },
      boxes: [
        box({ id: "logo", field: "clinic.logo", yMm: 5, hMm: 20 }),
        box({ id: "sig", field: "doctor.signature", yMm: 250, hMm: 15 }),
        box({ id: "addr", field: "clinic.address", yMm: 30, hMm: 15 }),
        box({ id: "foot", field: "clinic.footer", yMm: 280, hMm: 10 }),
        box({ id: "name", field: "patient.name", yMm: 52 }),
      ],
    });
    const hostile = HOSTILE.long5000 + HOSTILE.script;
    const doc = overlayDocument({
      items: manyItems(30).map((it) => ({ ...it, remarks: hostile })),
      snapshot: snapshot({ patient: { name: hostile }, clinic: { addressLines: [hostile], footerLines: [hostile] } }),
      visit: { ...overlayDocument().visit, advice: hostile, examinationNotes: hostile, chiefComplaint: hostile },
    });
    const out = render(doc, { target: "pdf", sample: false }, { templateVersionId: "v", definition: def, background: bg }, { logo: big(IMAGE_LIMITS.maxBytes), signature: big(IMAGE_LIMITS.maxBytes), fontCss: loadFontCss() });
    expect(out.html.length).toBeLessThan(MAX_DOCUMENT_CHARS);
    expect(checkSelfContained(out.html)).toEqual({ ok: true });
    expect(checkSelfContained(out.footerHtml)).toEqual({ ok: true });
    expect(parse(out.html).querySelectorAll(".meds tbody tr")).toHaveLength(30);
  });

  it("leaves a page-number band only when asked, and sends Gotenberg the matching margins", () => {
    const banded = render(overlayDocument(), SCREEN, overlayInput(overlayDefinition({ pageNumbers: { bandMm: 8 } })));
    expect(css(banded.html)).toContain("@page{size:A4 portrait;margin:0mm 0mm 8mm 0mm}");
    expect(css(banded.html)).toContain("height:289mm");
    expect(banded.paper.marginMm).toEqual({ top: 0, right: 0, bottom: 8, left: 0 });
    expect(banded.footerHtml).toContain('class="pageNumber"');
    const plain = render();
    expect(plain.paper.marginMm).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
    expect(plain.footerHtml).toBe(EMPTY_FOOTER);
  });

  it("keeps all 30 medicines in one repeating table", () => {
    const page = parse(render(overlayDocument({ items: manyItems(30) })).html);
    expect(page.querySelectorAll(".meds tbody tr")).toHaveLength(30);
    expect(page.querySelectorAll(".meds thead")).toHaveLength(1);
  });

  it("is deterministic", () => {
    const doc = overlayDocument({ snapshot: snapshot({ patient: { name: DEVANAGARI.name } }) });
    expect(render(doc).html).toBe(render(doc).html);
  });
});

describe("overlayCss", () => {
  it("contains only CSS built from numbers and fixed words", () => {
    const text = overlayCss(overlayDefinition(), PAPER.A4, { x: 0, y: 0 });
    expect(text).toMatch(/^[a-z0-9.\-{}:;%(),> @\n]+$/i);
  });

  it("throws on a number that is not finite (a programming error: the schema refuses it)", () => {
    const def = overlayDefinition();
    expect(() => overlayCss({ ...def, boxes: [{ ...def.boxes[0], xMm: Number.NaN }] }, PAPER.A4, { x: 0, y: 0 })).toThrow();
  });
});

describe("overlay golden files", () => {
  const assets: RenderAssets = { ...NO_ASSETS, logo: TINY_PNG, signature: TINY_PNG };

  it("A4, English, three medicines (screen)", async () => {
    await expect(render(overlayDocument(), SCREEN, overlayInput(), assets).html).toMatchFileSnapshot("./__golden__/overlay-a4-en.html");
  });

  it("A5, bilingual, 12 medicines, Devanagari name (pdf)", async () => {
    const doc = overlayDocument({ layout: { paperSize: "A5", labels: "bilingual" }, items: manyItems(12), snapshot: snapshot({ patient: { name: DEVANAGARI.name }, layout: { paperSize: "A5", labels: "bilingual" } }) });
    await expect(render(doc, { target: "pdf", sample: false }, overlayInput(a5Definition()), assets).html).toMatchFileSnapshot("./__golden__/overlay-a5-bilingual-long.html");
  });

  it("draft with a signature box (screen)", async () => {
    const def = overlayDefinition({ signature: { mode: "box" }, boxes: [...overlayDefinition().boxes, box({ id: "sig", field: "doctor.signature", xMm: 140, yMm: 255, wMm: 50, hMm: 15 })] });
    await expect(render(overlayDocument({ status: "draft", rxNo: null, issuedAt: null, snapshotSource: "live" }), SCREEN, overlayInput(def), assets).html).toMatchFileSnapshot("./__golden__/overlay-draft-signature-box.html");
  });

  it("pre-printed paper with a printer offset (print)", async () => {
    const def = overlayDefinition({ background: { printMode: "pdf_only" }, printOffsetMm: { x: 1.5, y: -2 }, pageNumbers: { bandMm: 8 } });
    await expect(render(overlayDocument(), { target: "print", sample: false }, overlayInput(def), assets).html).toMatchFileSnapshot("./__golden__/overlay-print-preprinted.html");
  });
});
