import { describe, expect, it } from "vitest";
import { renderPrescription, footerTemplate } from "@/lib/rx-render/render";
import { checkSelfContained } from "@/lib/rx-render/self-contained";
import { BUILTIN_TEMPLATES, LABEL_LANGUAGES, PAPER_SIZES, type RenderAssets, type RxDocument } from "@/lib/rx-render/types";
import { translations } from "@/lib/translations";
import { DEVANAGARI, HOSTILE, TINY_PNG, documentFixture, item, manyItems, snapshot, visit } from "../fixtures/rx-documents";

const NO_ASSETS: RenderAssets = { logo: null, signature: null, fontCss: "" };
const parse = (markup: string) => new DOMParser().parseFromString(markup, "text/html");
const render = (doc: RxDocument, assets: RenderAssets = NO_ASSETS) => renderPrescription(doc, assets);
const text = (markup: string) => parse(markup).body.textContent ?? "";

function hostileDocument(overrides: Partial<RxDocument> = {}): RxDocument {
  return documentFixture({
    snapshot: snapshot({
      patient: { name: HOSTILE.script, allergies: [HOSTILE.img] },
      clinic: { name: HOSTILE.img, addressLines: [HOSTILE.urls], phone: HOSTILE.quotes, email: HOSTILE.script, footerLines: [HOSTILE.script] },
      doctor: { name: HOSTILE.quotes, qualifications: HOSTILE.urls, designation: HOSTILE.img, registrationNo: HOSTILE.script, registrationCouncil: HOSTILE.urls },
    }),
    visit: visit({
      chiefComplaint: HOSTILE.script,
      complaints: [HOSTILE.img],
      diagnosis: [HOSTILE.urls],
      medicalHistory: [HOSTILE.quotes],
      drugHistory: [HOSTILE.script],
      examinationNotes: HOSTILE.img,
      vitals: { pulse: 80, notes: HOSTILE.script },
      investigations: [{ name: HOSTILE.script, instructions: HOSTILE.img }],
      advice: `${HOSTILE.script}\n${HOSTILE.longWord}`,
      followUpReason: HOSTILE.urls,
    }),
    items: [
      item(1, {
        drugName: HOSTILE.script,
        genericName: HOSTILE.img,
        strength: HOSTILE.quotes,
        dose: HOSTILE.urls,
        route: HOSTILE.script,
        remarks: HOSTILE.img,
        foodRelation: "<b>bold</b>",
        periodicity: HOSTILE.img,
      }),
      item(2, { doseMorning: null, doseAfternoon: null, doseNight: null, timing: HOSTILE.img }),
    ],
    ...overrides,
  });
}

function withLayout(doc: RxDocument, layout: Partial<RxDocument["snapshot"]["layout"]>): RxDocument {
  return { ...doc, snapshot: { ...doc.snapshot, layout: { ...doc.snapshot.layout, ...layout } } };
}

describe("hostile text", () => {
  for (const key of BUILTIN_TEMPLATES) {
    for (const labels of LABEL_LANGUAGES) {
      it(`prints every field literally in ${key} / ${labels}`, () => {
        const doc = withLayout(hostileDocument(), { template: { kind: "builtin", key }, paperSize: "A4", labels });
        const out = render(doc, { ...NO_ASSETS, signature: TINY_PNG });
        const dom = parse(out.html);

        expect(checkSelfContained(out.html)).toEqual({ ok: true });
        expect(dom.querySelectorAll("script, iframe, object, embed, link, svg, a, form, base")).toHaveLength(0);
        expect(dom.querySelectorAll("img")).toHaveLength(1); // only the signature we passed in
        const handlers = Array.from(dom.querySelectorAll("*")).flatMap((el) => Array.from(el.attributes)).filter((a) => a.name.startsWith("on"));
        expect(handlers).toHaveLength(0);
        expect(out.html).not.toContain("<script");
        expect(out.html).not.toContain("<img src=x");

        const body = dom.body.textContent ?? "";
        expect(body).toContain(HOSTILE.script);
        expect(body).toContain(HOSTILE.img);
        expect(body).toContain("<b>bold</b>");
      });
    }
  }

  it("keeps a 2,000-character word and lets it wrap instead of overflowing", () => {
    const out = render(hostileDocument());
    expect(text(out.html)).toContain(HOSTILE.longWord);
    expect(out.html).toContain("overflow-wrap:anywhere");
  });

  it("isolates right-to-left overrides so they cannot reorder the labels around them", () => {
    expect(HOSTILE.bidi.codePointAt(0)).toBe(0x202e);
    expect(Array.from(HOSTILE.bidi)).toHaveLength(6);
    const dom = parse(render(documentFixture({ snapshot: snapshot({ patient: { name: HOSTILE.bidi } }) })).html);
    const holder = Array.from(dom.querySelectorAll("span.v")).find((el) => el.textContent === HOSTILE.bidi);
    expect(holder).toBeDefined();
    expect(dom.querySelector("style")?.textContent).toContain(".v{unicode-bidi:isolate}");
  });

  it("strips control characters and survives a lone surrogate", () => {
    expect(Array.from(HOSTILE.controls)).toHaveLength(7);
    const dom = parse(render(documentFixture({ snapshot: snapshot({ patient: { name: HOSTILE.controls } }) })).html);
    expect(dom.querySelector(".patient-main .v")?.textContent).toBe("abcd");
    const out = render(documentFixture({ snapshot: snapshot({ patient: { name: HOSTILE.loneSurrogate } }) }));
    expect(checkSelfContained(out.html)).toEqual({ ok: true });
  });

  it("renders a quote-and-handler attribute breaker as inert text", () => {
    const out = render(documentFixture({ snapshot: snapshot({ patient: { name: HOSTILE.attrBreaker } }) }));
    expect(checkSelfContained(out.html)).toEqual({ ok: true });
    expect(out.html).toContain("&quot; onmouseover=&quot;alert(1)&quot; x=&quot;");
    expect(parse(out.html).querySelectorAll("[onmouseover]")).toHaveLength(0);
  });
});

describe("self-contained output", () => {
  const variants: Array<[string, Partial<RxDocument>]> = [
    ["finalized", {}],
    ["draft", { status: "draft", rxNo: null, issuedAt: null, snapshotSource: "live" }],
    ["superseded", { status: "amended", supersededBy: { version: 2, issuedAt: "2026-11-13T04:00:00.000Z" } }],
    ["amended without a replacing version", { status: "amended" }],
    ["amendment", { version: 2, replacesVersion: 1 }],
    ["legacy live snapshot", { snapshotSource: "live" }],
  ];

  for (const key of BUILTIN_TEMPLATES) {
    for (const paperSize of PAPER_SIZES) {
      for (const labels of LABEL_LANGUAGES) {
        it(`passes checkSelfContained for ${key} / ${paperSize} / ${labels} in every status`, () => {
          for (const [name, overrides] of variants) {
            const doc = withLayout(documentFixture({ ...overrides, items: manyItems(3) }), { template: { kind: "builtin", key }, paperSize, labels });
            const out = render(doc, { ...NO_ASSETS, logo: TINY_PNG, signature: TINY_PNG });
            expect(checkSelfContained(out.html), name).toEqual({ ok: true });
            expect(out.html).toContain('data-rx="ready"');
            expect(checkSelfContained(out.footerHtml), name).toEqual({ ok: true });
          }
        });
      }
    }
  }

  it("passes for a 30-medicine document in every template", () => {
    for (const key of BUILTIN_TEMPLATES) {
      const doc = withLayout(documentFixture({ items: manyItems(30) }), { template: { kind: "builtin", key } });
      expect(checkSelfContained(render(doc, { ...NO_ASSETS, signature: TINY_PNG }).html)).toEqual({ ok: true });
    }
  });

  it("passes with hostile fixtures on a draft and a superseded copy", () => {
    expect(checkSelfContained(render(hostileDocument({ status: "draft", rxNo: null })).html)).toEqual({ ok: true });
    expect(checkSelfContained(render(hostileDocument({ status: "amended", supersededBy: { version: 3, issuedAt: "2026-11-13T04:00:00.000Z" } })).html)).toEqual({ ok: true });
  });

  it("uses no CSS comments, url() or style attributes of its own", () => {
    const out = render(documentFixture(), { ...NO_ASSETS, logo: TINY_PNG });
    const css = parse(out.html).querySelector("style")?.textContent ?? "";
    expect(css).not.toContain("/*");
    expect(css).not.toMatch(/url\s*\(/i);
    expect(parse(out.html).querySelectorAll("[style]")).toHaveLength(0);
  });

  it("puts the content security policy in a meta tag", () => {
    const meta = parse(render(documentFixture()).html).querySelector('meta[http-equiv="Content-Security-Policy"]');
    expect(meta?.getAttribute("content")).toBe("default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'");
  });
});

describe("damaged numbers", () => {
  it("never prints NaN or Infinity", () => {
    const doc = documentFixture({
      visit: visit({ vitals: { bpSystolic: Number.NaN, bpDiastolic: 80, pulse: Number.POSITIVE_INFINITY, weightKg: -5, heightCm: Number.NaN } }),
      items: [item(1, { doseMorning: Number.NaN, doseNight: Number.POSITIVE_INFINITY, durationValue: Number.NaN })],
    });
    for (const key of BUILTIN_TEMPLATES) {
      const out = render(withLayout(doc, { template: { kind: "builtin", key } }));
      expect(text(out.html)).not.toMatch(/NaN|Infinity/);
      expect(checkSelfContained(out.html)).toEqual({ ok: true });
    }
  });
});

describe("pagination structure", () => {
  it("prints 30 medicines in order inside a repeating table header, with rows that never split", () => {
    const out = render(documentFixture({ items: manyItems(30) }));
    const dom = parse(out.html);
    const rows = Array.from(dom.querySelectorAll(".meds tbody tr"));
    expect(rows).toHaveLength(30);
    rows.forEach((row, i) => expect(row.querySelector(".med-name")?.textContent?.startsWith(`${i + 1}. Medicine ${i + 1}`)).toBe(true));
    expect(dom.querySelector("table.sheet > thead .pad-head")).not.toBeNull();
    expect(dom.querySelector("table.sheet > tfoot .pad-foot")).not.toBeNull();
    expect(out.html).toContain(".sheet>thead{display:table-header-group}");
    expect(out.html).toContain(".sheet>tfoot{display:table-footer-group}");
    expect(out.html).toContain(".meds>thead{display:table-header-group}");
    expect(out.html).toContain(".meds tr{break-inside:avoid;page-break-inside:avoid}");
  });

  it("sets the page size and margins for A4 and A5", () => {
    expect(render(documentFixture()).html).toContain("@page{size:A4 portrait;margin:12mm 12mm 14mm 12mm}");
    const a5 = render(documentFixture({ layout: { paperSize: "A5" } }));
    expect(a5.html).toContain("@page{size:A5 portrait;margin:9mm 9mm 12mm 9mm}");
    expect(a5.paper).toMatchObject({ size: "A5", widthIn: 5.83, heightIn: 8.27 });
  });

  it("carries long Devanagari text in full and marks the document Hindi", () => {
    const doc = documentFixture({
      layout: { labels: "hi" },
      snapshot: snapshot({ patient: { name: DEVANAGARI.name }, layout: { labels: "hi" } }),
      visit: visit({ advice: DEVANAGARI.advice, complaints: [DEVANAGARI.complaint] }),
    });
    const out = render(doc);
    expect(out.html).toContain('<html lang="hi">');
    expect(text(out.html)).toContain(DEVANAGARI.advice);
    expect(text(out.html)).toContain(DEVANAGARI.name);
    expect(checkSelfContained(out.html)).toEqual({ ok: true });
  });

  it("keeps joiner characters in conjuncts", () => {
    expect(DEVANAGARI.conjuncts).toContain(String.fromCodePoint(0x200d));
    const out = render(documentFixture({ snapshot: snapshot({ patient: { name: DEVANAGARI.conjuncts } }) }));
    expect(text(out.html)).toContain(DEVANAGARI.conjuncts);
  });
});

describe("templates", () => {
  it("General prints morning/noon/evening/night columns and free-text timing across them", () => {
    const dom = parse(render(documentFixture()).html);
    expect(dom.querySelector(".meds-slots")).not.toBeNull();
    const headings = Array.from(dom.querySelectorAll(".meds th")).map((th) => th.textContent);
    expect(headings).toEqual(expect.arrayContaining(["Mor", "Noon", "Eve", "Night"]));
    const first = Array.from(dom.querySelectorAll(".meds tbody tr")[0].querySelectorAll("td.slot")).map((td) => td.textContent);
    expect(first).toEqual(["1", "0", "0", "1"]);
    const free = dom.querySelectorAll(".meds tbody tr")[2].querySelector("td.slot-text");
    expect(free?.getAttribute("colspan")).toBe("4");
    expect(free?.textContent).toBe("After every loose stool");
    expect(dom.querySelector(".vitals")?.textContent).toContain("BP 130/85 mmHg");
  });

  it("Paediatric leads with weight and prints dose and schedule columns", () => {
    const dom = parse(render(documentFixture({ layout: { template: { kind: "builtin", key: "paediatric" } } })).html);
    expect(dom.querySelector(".meds-pattern")).not.toBeNull();
    expect(dom.querySelector(".patient")?.textContent).toContain("Weight: 70 kg");
    expect(dom.querySelector(".meds tbody tr td.when")?.textContent).toBe("1-0-1");
  });

  it("Derma prints how to use each medicine and no vitals", () => {
    const dom = parse(render(documentFixture({ layout: { template: { kind: "builtin", key: "derma" } } })).html);
    expect(dom.querySelector(".meds-topical")).not.toBeNull();
    expect(dom.querySelector(".vitals")).toBeNull();
    expect(dom.querySelector(".meds tbody tr td.how")?.textContent).toBe("Oral · 1 tab · 1-0-1 · After food");
  });

  it("omits empty sections", () => {
    const dom = parse(render(documentFixture({ visit: visit({ advice: null, investigations: [], examinationNotes: "  " }) })).html);
    expect(dom.body.textContent).not.toContain("Advice");
    expect(dom.body.textContent).not.toContain("Investigations");
    expect(dom.body.textContent).not.toContain("Examination");
  });
});

describe("labels", () => {
  it("uses English, Hindi, or both for headings and coded values", () => {
    expect(text(render(documentFixture()).html)).toContain("Diagnosis:");
    expect(text(render(documentFixture()).html)).toContain("After food");

    const hindi = text(render(documentFixture({ layout: { labels: "hi" } })).html);
    expect(hindi).toContain(`${translations.hindi.diagnosis}:`);
    expect(hindi).toContain(translations.hindi.after);

    const both = render(documentFixture({ layout: { labels: "bilingual" } })).html;
    expect(text(both)).toContain(`Diagnosis / ${translations.hindi.diagnosis}:`);
    expect(parse(both).querySelector(".meds th .l-hi")?.textContent).toBe(translations.hindi.medicine);
  });
});

describe("status markers", () => {
  it("watermarks a draft, shows no Rx number, and dates it on the day it was rendered", () => {
    const dom = parse(render(documentFixture({ status: "draft", rxNo: null, issuedAt: null, snapshotSource: "live" })).html);
    expect(dom.querySelector(".watermark")?.textContent).toBe("DRAFT · NOT VALID FOR DISPENSING");
    expect(dom.querySelector(".banner-draft")).not.toBeNull();
    expect(dom.body.textContent).not.toContain("Rx No.");
    expect(dom.querySelector(".patient-meta")?.textContent).toContain("12/11/2026");
    expect(dom.querySelector(".note")).toBeNull();
  });

  it("marks a superseded version on every page with the version that replaced it", () => {
    const dom = parse(
      render(documentFixture({ status: "amended", supersededBy: { version: 2, issuedAt: "2026-11-13T04:00:00.000Z" } })).html,
    );
    expect(dom.querySelector(".watermark")?.textContent).toBe("SUPERSEDED");
    expect(dom.querySelector("thead .banner-superseded")?.textContent).toBe(
      "SUPERSEDED by version 2 issued 13/11/2026. Do not dispense from this copy.",
    );
  });

  it("still marks an amended copy superseded when the replacing version is unknown", () => {
    const dom = parse(render(documentFixture({ status: "amended" })).html);
    expect(dom.querySelector(".watermark")?.textContent).toBe("SUPERSEDED");
    expect(dom.querySelector("thead .banner-superseded")?.textContent).toContain("Do not dispense from this copy.");
  });

  it("shows an amendment's version and what it replaces", () => {
    const dom = parse(render(documentFixture({ version: 2, replacesVersion: 1 })).html);
    expect(dom.querySelector(".patient-meta")?.textContent).toContain("12 (v2)");
    expect(dom.querySelector(".patient-meta")?.textContent).toContain("Replaces version 1");
  });

  it("says when a finalized prescription was printed from today's details", () => {
    const dom = parse(render(documentFixture({ snapshotSource: "live" })).html);
    expect(dom.querySelector(".note")?.textContent).toContain("finalized before print snapshots were recorded");
  });
});

describe("assets", () => {
  it("embeds the logo and signature as data URIs", () => {
    const dom = parse(render(documentFixture(), { ...NO_ASSETS, logo: TINY_PNG, signature: TINY_PNG }).html);
    expect(dom.querySelector(".logo img")?.getAttribute("src")).toBe(`data:image/png;base64,${TINY_PNG.base64}`);
    expect(dom.querySelector(".sig-box img")).not.toBeNull();
  });

  it("keeps the signature block intact without a signature image", () => {
    const dom = parse(render(documentFixture()).html);
    expect(dom.querySelector(".sig-box")?.children).toHaveLength(0);
    expect(dom.querySelector(".sig-name")?.textContent).toBe("Dr. Meera Shah");
    expect(dom.querySelector(".sig-line")?.textContent).toBe("Reg. No.: MMC 2011/04/1234");
  });

  it("drops an asset whose base64 is not base64", () => {
    const dom = parse(render(documentFixture(), { ...NO_ASSETS, logo: { ...TINY_PNG, base64: '"><script>' } }).html);
    expect(dom.querySelector(".logo")).toBeNull();
  });

  it("places the font CSS before the document CSS", () => {
    const out = render(documentFixture(), { ...NO_ASSETS, fontCss: ".fonts-marker{}" });
    expect(out.html.indexOf(".fonts-marker{}")).toBeGreaterThan(-1);
    expect(out.html.indexOf(".fonts-marker{}")).toBeLessThan(out.html.indexOf("@page"));
  });
});

describe("determinism and the PDF footer", () => {
  it("renders byte-identical HTML for the same input", () => {
    expect(render(documentFixture()).html).toBe(render(documentFixture()).html);
  });

  it("titles the document without patient data", () => {
    expect(render(documentFixture()).title).toBe("Prescription Rx-12 v1");
    expect(render(documentFixture({ status: "draft", rxNo: null })).title).toBe("Prescription draft v1");
  });

  it("builds a self-contained page-number footer with no patient data", () => {
    const doc = documentFixture();
    const footer = footerTemplate(doc, render(doc).paper);
    expect(footer).toContain('class="pageNumber"');
    expect(footer).toContain('class="totalPages"');
    expect(footer).toContain("Rx 12 v1");
    expect(footer).not.toContain("Asha");
    expect(checkSelfContained(footer)).toEqual({ ok: true });
  });
});

describe("golden files", () => {
  const assets: RenderAssets = { ...NO_ASSETS, logo: TINY_PNG, signature: TINY_PNG };

  it("General, A4, English", async () => {
    await expect(render(documentFixture(), assets).html).toMatchFileSnapshot("./__golden__/rx-general-a4-en.html");
  });

  it("Paediatric, A5, bilingual", async () => {
    const doc = documentFixture({ layout: { template: { kind: "builtin", key: "paediatric" }, paperSize: "A5", labels: "bilingual" } });
    await expect(render(doc, assets).html).toMatchFileSnapshot("./__golden__/rx-paediatric-a5-bilingual.html");
  });

  it("Derma, A4, Hindi", async () => {
    const doc = documentFixture({ layout: { template: { kind: "builtin", key: "derma" }, labels: "hi" } });
    await expect(render(doc, assets).html).toMatchFileSnapshot("./__golden__/rx-derma-a4-hi.html");
  });

  it("General draft", async () => {
    const doc = documentFixture({ status: "draft", rxNo: null, issuedAt: null, snapshotSource: "live" });
    await expect(render(doc, NO_ASSETS).html).toMatchFileSnapshot("./__golden__/rx-general-draft.html");
  });

  it("General with hostile text, escaped", async () => {
    const out = render(hostileDocument(), NO_ASSETS).html;
    expect(out).not.toContain("<script");
    await expect(out).toMatchFileSnapshot("./__golden__/rx-general-hostile.html");
  });
});
