import { describe, expect, it } from "vitest";
import { renderPrescription, footerTemplate } from "@/lib/rx-render/render";
import { checkSelfContained } from "@/lib/rx-render/self-contained";
import { BUILTIN_TEMPLATES, LABEL_LANGUAGES, PAPER_SIZES, type RenderAssets, type RxDocument, type RxItem } from "@/lib/rx-render/types";
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
        timing: HOSTILE.attrBreaker,
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
        // Item 1 has dose slots, so its free-text timing is printed too; it must stay inert text.
        expect(body).toContain(HOSTILE.attrBreaker);
        expect(dom.querySelectorAll("[onmouseover]")).toHaveLength(0);
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

  it("Derma prints how to use each medicine and a compact vitals line", () => {
    const dom = parse(render(documentFixture({ layout: { template: { kind: "builtin", key: "derma" } } })).html);
    expect(dom.querySelector(".meds-topical")).not.toBeNull();
    expect(dom.querySelector(".vitals.vitals-compact")?.textContent).toContain("BP 130/85 mmHg");
    expect(dom.querySelector(".meds tbody tr td.how")?.textContent).toBe("1 tab · 1-0-1 · After food");
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

  it("sizes the footer to the full page width so the Rx number and the page number sit at opposite edges", () => {
    // Found by reading the real Gotenberg PDF: without these two rules Chromium shrink-wraps the footer
    // and prints "Rx 12 v1Page 1 of 7" at the left edge. Re-verified with PyMuPDF word positions (see ADR-0034).
    for (const paperSize of ["A4", "A5"] as const) {
      const doc = withLayout(documentFixture(), { paperSize });
      const footer = footerTemplate(doc, render(doc).paper);
      expect(footer, paperSize).toContain("html,body{margin:0;padding:0;width:100%}");
      expect(footer, paperSize).toContain(".f{width:100%;box-sizing:border-box;display:flex;justify-content:space-between;");
    }
  });
});

const URDU = "لگائیں"; // Arabic-script text (6 code points)

const FULL_ITEM_ONE: RxItem = {
  drugName: "IDRUGONE", genericName: "IGENONE", strength: "ISTRONE", form: "IFORMONE", route: "IROUTEONE", dose: "IDOSEONE",
  doseMorning: 1, doseAfternoon: 0.5, doseEvening: 3, doseNight: 2, timing: "ITIMINGONE", foodRelation: "before",
  periodicity: "alternate_day", isSos: true, durationValue: 7, durationUnit: "weeks", durationDays: 49, remarks: "IREMARKONE",
};
const FULL_ITEM_TWO: RxItem = {
  ...FULL_ITEM_ONE, drugName: "IDRUGTWO", genericName: "IGENTWO", strength: "ISTRTWO", form: "IFORMTWO", route: "IROUTETWO", dose: "IDOSETWO",
  doseMorning: null, doseAfternoon: null, doseEvening: null, doseNight: null, timing: "ITIMINGTWO", isSos: false, remarks: "IREMARKTWO",
  foodRelation: "with_tea", periodicity: "monthly", durationValue: 3, durationUnit: "months",
};

function fullDocument(): RxDocument {
  return documentFixture({
    version: 3,
    replacesVersion: 2,
    snapshot: snapshot({
      patient: { name: "PNAME", patientNo: 4242, gender: "male", ageLabel: "7 y", allergies: ["PALLERGYONE", "PALLERGYTWO"] },
      clinic: { name: "CNAME", addressLines: ["CADDRONE", "CADDRTWO"], phone: "CPHONE", email: "cemail@example.in", footerLines: ["CFOOTONE", "CFOOTTWO"] },
      doctor: { name: "DNAME", qualifications: "DQUAL", designation: "DDESIG", registrationNo: "DREGNO", registrationCouncil: "DCOUNCIL" },
    }),
    visit: visit({
      chiefComplaint: "VCHIEF", complaints: ["VCOMPONE", "VCOMPTWO"], diagnosis: ["VDIAGONE", "VDIAGTWO"], medicalHistory: ["VMEDHIST"],
      drugHistory: ["VDRUGHIST"], examinationNotes: "VEXAM",
      vitals: { bpSystolic: 131, bpDiastolic: 86, pulse: 93, temperatureF: 101.3, spo2: 96, respiratoryRate: 19, weightKg: 23.5, heightCm: 120.5, bloodSugarMgDl: 141, notes: "VVITALNOTES" },
      investigations: [{ name: "VINVONE", instructions: "VINVINSONE" }, { name: "VINVTWO" }],
      advice: "VADVICE", followUpDate: "2026-12-03", followUpReason: "VFUREASON",
    }),
    items: [FULL_ITEM_ONE, FULL_ITEM_TWO],
  });
}

const COMPLETENESS_MARKERS = [
  "PNAME", "4242", "Male", "7 y", "PALLERGYONE", "PALLERGYTWO",
  "CNAME", "CADDRONE", "CADDRTWO", "CPHONE", "cemail@example.in", "CFOOTONE", "CFOOTTWO",
  "DNAME", "DQUAL", "DDESIG", "DREGNO", "DCOUNCIL",
  "VCHIEF", "VCOMPONE", "VCOMPTWO", "VDIAGONE", "VDIAGTWO", "VMEDHIST", "VDRUGHIST", "VEXAM",
  "131/86", "93/min", "101.3 °F", "96%", "19/min", "23.5 kg", "120.5 cm", "141 mg/dL", "VVITALNOTES",
  "VINVONE", "VINVINSONE", "VINVTWO", "VADVICE", "03/12/2026", "VFUREASON", "12/11/2026", "12 (v3)", "Replaces version 2",
  "IDRUGONE", "IGENONE", "ISTRONE", "IFORMONE", "IROUTEONE", "IDOSEONE", "ITIMINGONE", "Before food", "Alternate days", "SOS", "7 weeks", "IREMARKONE",
  "IDRUGTWO", "IGENTWO", "ISTRTWO", "IFORMTWO", "IROUTETWO", "IDOSETWO", "ITIMINGTWO", "With tea or snacks", "Monthly", "3 months", "IREMARKTWO",
];

describe("completeness: nothing recorded is dropped", () => {
  for (const key of BUILTIN_TEMPLATES) {
    it(`prints every recorded field in ${key}`, () => {
      const out = render(withLayout(fullDocument(), { template: { kind: "builtin", key } }), { ...NO_ASSETS, logo: TINY_PNG, signature: TINY_PNG });
      const dom = parse(out.html);
      const body = dom.body.textContent ?? "";
      expect(COMPLETENESS_MARKERS.filter((marker) => !body.includes(marker))).toEqual([]);
      expect(dom.querySelectorAll("img")).toHaveLength(2);
      if (key === "general") {
        expect(Array.from(dom.querySelectorAll(".meds tbody tr")[0].querySelectorAll("td.slot")).map((td) => td.textContent)).toEqual(["1", "½", "3", "2"]);
      } else {
        expect(body).toContain("1-½-3-2");
      }
      expect(out.title).toBe("Prescription Rx-12 v3");
      expect(out.footerHtml).toContain("Rx 12 v3");
      expect(checkSelfContained(out.html)).toEqual({ ok: true });
    });

    it(`prints every user value on a Hindi pad in ${key}`, () => {
      const out = render(withLayout(fullDocument(), { template: { kind: "builtin", key }, labels: "hi" }));
      const body = text(out.html);
      const userMarkers = COMPLETENESS_MARKERS.filter((m) => /^[A-Z]{4,}$/.test(m));
      expect(userMarkers.length).toBeGreaterThan(30);
      expect(userMarkers.filter((marker) => !body.includes(marker))).toEqual([]);
    });
  }

  it("prints distinct M/A/E/N doses in their own columns", () => {
    const dom = parse(render(fullDocument()).html);
    const cells = Array.from(dom.querySelectorAll(".meds tbody tr")[0].querySelectorAll("td.slot")).map((td) => td.textContent);
    expect(cells).toEqual(["1", "½", "3", "2"]);
  });

  it("prints free-text timing together with dose slots, slots first, on every template", () => {
    for (const key of BUILTIN_TEMPLATES) {
      const doc = withLayout(documentFixture({ items: [item(1, { doseMorning: 1, doseAfternoon: 0, doseEvening: null, doseNight: 1, timing: "every 6 hours" })] }), { template: { kind: "builtin", key } });
      const body = text(render(doc).html);
      expect(body, key).toContain("every 6 hours");
      if (key === "general") {
        const dom = parse(render(doc).html);
        expect(Array.from(dom.querySelectorAll("td.slot")).map((td) => td.textContent), key).toEqual(["1", "0", "0", "1"]);
      } else {
        expect(body.indexOf("1-0-1"), key).toBeGreaterThan(-1);
        expect(body.indexOf("1-0-1"), key).toBeLessThan(body.indexOf("every 6 hours"));
      }
    }
    const pattern = parse(render(withLayout(documentFixture({ items: [item(1, { timing: "every 6 hours" })] }), { template: { kind: "builtin", key: "paediatric" } })).html);
    expect(pattern.querySelector("td.when")?.textContent).toBe("1-0-1 · every 6 hours");
    const derma = parse(render(withLayout(documentFixture({ items: [item(1, { timing: "every 6 hours" })] }), { template: { kind: "builtin", key: "derma" } })).html);
    expect(derma.querySelector("td.how")?.textContent).toBe("1 tab · 1-0-1 · every 6 hours · After food");
  });

  it("prints strength, form and route with the medicine name on every template", () => {
    for (const key of BUILTIN_TEMPLATES) {
      const doc = withLayout(documentFixture({ items: [item(1, { drugName: "Drops", strength: "0.5%", form: "Eye drops", route: "Ophthalmic" })] }), { template: { kind: "builtin", key } });
      const name = parse(render(doc).html).querySelector(".meds tbody tr .med-name")?.textContent;
      expect(name, key).toBe("1. Drops 0.5% Eye drops · Ophthalmic");
    }
  });

  it("prints blood sugar and drug history on Paediatric", () => {
    const body = text(render(documentFixture({ layout: { template: { kind: "builtin", key: "paediatric" } }, visit: visit({ vitals: { bloodSugarMgDl: 141 }, drugHistory: ["DHIST"] }) })).html);
    expect(body).toContain("141 mg/dL");
    expect(body).toContain("DHIST");
  });

  it("prints Derma vitals notes even when nothing else is recorded", () => {
    const dom = parse(render(documentFixture({ layout: { template: { kind: "builtin", key: "derma" } }, visit: visit({ vitals: { notes: "VNOTE" } }) })).html);
    expect(dom.querySelector(".vitals-compact")?.textContent).toContain("VNOTE");
  });
});

describe("drafts never carry an Rx number", () => {
  for (const key of BUILTIN_TEMPLATES) {
    it(`omits the number of an amendment draft in ${key}`, () => {
      const doc = withLayout(documentFixture({ status: "draft", rxNo: 12, version: 2, replacesVersion: 1, issuedAt: null, snapshotSource: "live" }), { template: { kind: "builtin", key } });
      const out = render(doc);
      const dom = parse(out.html);
      expect(out.title).toBe("Prescription draft v2");
      expect(out.footerHtml).not.toContain("Rx 12");
      expect(out.footerHtml).toContain("Draft");
      expect(dom.body.textContent).not.toContain("Rx No.");
      expect(dom.querySelector(".patient-meta")?.textContent).not.toMatch(/12 /);
      expect(dom.querySelector(".patient-meta")?.textContent).toContain("Draft amendment of version 1");
      expect(footerTemplate(doc, out.paper)).not.toContain("Rx 12");
    });
  }

  it("says it in Hindi on a Hindi pad", () => {
    const doc = documentFixture({ status: "draft", rxNo: 12, version: 2, replacesVersion: 1, issuedAt: null, layout: { labels: "hi" } });
    expect(text(render(doc).html)).toContain("संस्करण 1 का संशोधन मसौदा");
  });
});

describe("bidirectional safety in joined cells", () => {
  it("keeps every part of the Derma how-to-use cell in its own isolated span", () => {
    expect(Array.from(URDU)).toHaveLength(6);
    const doc = withLayout(documentFixture({ items: [item(1, { route: URDU, dose: null, doseMorning: 1, doseAfternoon: 0, doseEvening: null, doseNight: 2, remarks: URDU })] }), { template: { kind: "builtin", key: "derma" } });
    const spans = Array.from(parse(render(doc).html).querySelectorAll("td.how span.v")).map((el) => el.textContent);
    // The route (URDU) belongs to the medicine name cell; the How cell must not repeat it.
    expect(spans).toEqual(["1-0-2", "After food"]);
  });

  it("isolates each allergy, list entry and frequency part on its own", () => {
    const doc = documentFixture({ snapshot: snapshot({ patient: { allergies: [URDU, "Sulfa 2"] } }), visit: visit({ complaints: [URDU, "Fever 2"] }) });
    const dom = parse(render(doc).html);
    expect(Array.from(dom.querySelectorAll(".allergies span.v")).map((el) => el.textContent)).toEqual([URDU, "Sulfa 2"]);
    expect(Array.from(dom.querySelectorAll("p.line span.v")).map((el) => el.textContent)).toEqual(expect.arrayContaining([URDU, "Fever 2"]));
    const freq = dom.querySelectorAll(".meds tbody tr")[0].querySelectorAll("td.center")[1];
    expect(Array.from(freq.querySelectorAll("span.v")).map((el) => el.textContent)).toEqual(["Daily", "5 days"]);
  });

  it("isolates unknown coded values as text", () => {
    const doc = documentFixture({ items: [item(1, { foodRelation: URDU, periodicity: URDU })] });
    const cells = Array.from(parse(render(doc).html).querySelectorAll(".meds tbody tr")[0].querySelectorAll("td.center span.v")).map((el) => el.textContent);
    expect(cells).toContain(URDU);
  });
});

describe("continuation pages", () => {
  it("repeats the patient and Rx strip in the page header", () => {
    for (const key of BUILTIN_TEMPLATES) {
      const dom = parse(render(withLayout(documentFixture(), { template: { kind: "builtin", key } })).html);
      const head = dom.querySelector("table.sheet > thead")?.textContent ?? "";
      expect(head, key).toContain("Asha Rao");
      expect(head, key).toContain("Rx No.");
      expect(head, key).toContain("12/11/2026");
      expect(dom.querySelector("table.sheet > tbody .patient")).toBeNull();
    }
  });

  it("keeps the signature with the last section and the last medicine row", () => {
    const out = render(documentFixture());
    const closing = parse(out.html).querySelector(".closing");
    expect(closing, "the closing wrapper must exist").not.toBeNull();
    expect(closing?.querySelector(".sig")).not.toBeNull();
    expect(closing?.querySelector(".block, .line")).not.toBeNull();
    expect(out.html).toContain(".closing{break-inside:avoid;page-break-inside:avoid}");
    expect(out.html).toContain(".meds tbody tr:last-child{break-after:avoid}");
  });
});

describe("dates use the clinic timezone", () => {
  const LATE = "2026-11-12T19:00:00.000Z"; // 13/11 00:30 in Asia/Kolkata, still 12/11 in UTC

  it("dates the pad and the superseded banner in the clinic zone, not UTC", () => {
    const dom = parse(render(documentFixture({ issuedAt: LATE, status: "amended", supersededBy: { version: 2, issuedAt: LATE } })).html);
    expect(dom.querySelector(".patient-meta")?.textContent).toContain("13/11/2026");
    expect(dom.querySelector(".patient-meta")?.textContent).not.toContain("12/11/2026");
    expect(dom.querySelector(".banner-superseded")?.textContent).toContain("issued 13/11/2026");
  });

  it("states the version of a superseded copy", () => {
    const dom = parse(render(documentFixture({ status: "amended", supersededBy: { version: 2, issuedAt: null } })).html);
    expect(dom.querySelector(".patient-meta")?.textContent).toContain("12 (v1)");
  });
});

describe("assets: mime", () => {
  it("drops an asset that is not PNG or JPEG", () => {
    for (const mime of ["image/svg+xml", 'image/png;base64,AAAA" onerror="x', "text/html"]) {
      const asset = { ...TINY_PNG, mime } as unknown as RenderAssets["logo"];
      const out = render(documentFixture(), { ...NO_ASSETS, logo: asset, signature: asset });
      expect(parse(out.html).querySelectorAll("img")).toHaveLength(0);
      expect(checkSelfContained(out.html)).toEqual({ ok: true });
    }
  });

  it("accepts JPEG", () => {
    const dom = parse(render(documentFixture(), { ...NO_ASSETS, logo: { ...TINY_PNG, mime: "image/jpeg" } }).html);
    expect(dom.querySelector(".logo img")?.getAttribute("src")).toMatch(/^data:image\/jpeg;base64,/);
  });
});

describe("tidy output", () => {
  it("hides non-positive vitals and whitespace-only entries", () => {
    const doc = documentFixture({
      visit: visit({ vitals: { heightCm: 0, weightKg: -5, pulse: 80, notes: "   " }, complaints: ["  ", ""], diagnosis: [" Viral ", " "], investigations: [{ name: "  " }, { name: "CBC" }] }),
    });
    const dom = parse(render(doc).html);
    const vitals = dom.querySelector(".vitals")?.textContent ?? "";
    expect(vitals).not.toMatch(/Height|-5/);
    expect(vitals).toContain("80/min");
    const lines = Array.from(dom.querySelectorAll("p.line")).map((p) => p.textContent);
    expect(lines.some((l) => l?.startsWith("Complaints"))).toBe(false);
    expect(lines).toContain("Diagnosis: Viral");
    expect(dom.querySelectorAll(".tests li")).toHaveLength(1);
  });

  it("draws no footer strip when the clinic has no footer lines", () => {
    const dom = parse(render(documentFixture({ snapshot: snapshot({ clinic: { footerLines: ["", "  "] } }) })).html);
    expect(dom.querySelector(".pad-foot")).toBeNull();
    expect(dom.querySelector("table.sheet > tfoot")).toBeNull();
  });

  it("labels the Paediatric and Derma duration column Frequency / Duration", () => {
    for (const key of ["paediatric", "derma"] as const) {
      const headings = Array.from(parse(render(documentFixture({ layout: { template: { kind: "builtin", key } } })).html).querySelectorAll(".meds th")).map((th) => th.textContent);
      expect(headings, key).toContain("Frequency / Duration");
    }
  });

  it("guards the title and footer against damaged numbers", () => {
    const doc = documentFixture({ rxNo: 1.5, version: Number.NaN });
    const out = render(doc);
    expect(out.title).toBe("Prescription draft");
    expect(footerTemplate(doc, out.paper)).toContain("Draft");
    expect(footerTemplate(doc, out.paper)).not.toMatch(/NaN/);
  });

  it("localizes status texts on Hindi and bilingual pads", () => {
    const hi = text(render(documentFixture({ status: "draft", rxNo: null, issuedAt: null, layout: { labels: "hi" } })).html);
    expect(hi).toContain("मसौदा");
    const both = parse(render(documentFixture({ status: "draft", rxNo: null, issuedAt: null, layout: { labels: "bilingual" } })).html);
    expect(both.querySelector(".watermark")?.textContent).toBe("DRAFT · NOT VALID FOR DISPENSING / मसौदा · दवा देने के लिए मान्य नहीं");
    const sup = text(render(documentFixture({ status: "amended", supersededBy: { version: 2, issuedAt: null }, layout: { labels: "hi" } })).html);
    expect(sup).toContain("संस्करण 2 द्वारा निरस्त");
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
