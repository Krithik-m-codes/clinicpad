import { describe, expect, it } from "vitest";
import { overlayDefinitionSchema } from "@/lib/rx-render/overlay-definition";
import { renderPrescription } from "@/lib/rx-render/render";
import { renderSnapshotSchema } from "@/lib/rx-render/snapshot";
import { TEMPLATE_DEFINITIONS, type SectionKey } from "@/lib/rx-render/templates";
import { BUILTIN_TEMPLATES, GALLERY_TEMPLATES, PAD_TEMPLATES, type RenderAssets } from "@/lib/rx-render/types";
import { checkSelfContained } from "@/lib/rx-render/self-contained";
import { documentFixture, TINY_PNG } from "../fixtures/rx-documents";
import { MINIMAL_OVERLAY_DEFINITION } from "../helpers/templates";

const ALL_SECTIONS: SectionKey[] = [
  "vitals", "chiefComplaint", "complaints", "medicalHistory", "drugHistory", "examination", "diagnosis", "medicines", "investigations", "advice", "followUp",
];
const ALL_VITALS = ["bp", "pulse", "temperatureF", "spo2", "respiratoryRate", "weightKg", "heightCm", "bmi", "bloodSugarMgDl"];
const NO_ASSETS: RenderAssets = { logo: null, signature: null, fontCss: "" };

describe("the specialty gallery", () => {
  it("adds six pads after the three originals, with unique keys", () => {
    expect([...GALLERY_TEMPLATES]).toEqual(["ortho", "ent", "gynae", "dental", "physio", "ayush"]);
    expect([...PAD_TEMPLATES]).toEqual([...BUILTIN_TEMPLATES, ...GALLERY_TEMPLATES]);
    expect(new Set(PAD_TEMPLATES).size).toBe(PAD_TEMPLATES.length);
    expect(Object.keys(TEMPLATE_DEFINITIONS).sort()).toEqual([...PAD_TEMPLATES].sort());
  });

  it.each([...PAD_TEMPLATES])("%s is complete: key matches, every section and vital once, valid accent, own name", (key) => {
    const def = TEMPLATE_DEFINITIONS[key];
    expect(def.key).toBe(key);
    expect([...def.sections].sort()).toEqual([...ALL_SECTIONS].sort());
    // The gallery drops no vital; the original Paediatric pad has never printed BMI and stays as it was.
    if ((GALLERY_TEMPLATES as readonly string[]).includes(key)) expect([...def.vitals].sort()).toEqual([...ALL_VITALS].sort());
    expect(def.accent).toMatch(/^#[0-9a-f]{6}$/);
    expect(def.name.trim().length).toBeGreaterThan(2);
    expect(def.description.trim().length).toBeGreaterThan(20);
  });

  it("gives every pad its own name and accent so the chooser tells them apart", () => {
    const defs = PAD_TEMPLATES.map((k) => TEMPLATE_DEFINITIONS[k]);
    expect(new Set(defs.map((d) => d.name)).size).toBe(defs.length);
    expect(new Set(defs.map((d) => d.accent)).size).toBe(defs.length);
    expect(new Set(defs.map((d) => `${d.sections.join()}|${d.vitals.join()}|${d.medicineLayout}`)).size).toBe(defs.length);
  });

  it.each([...GALLERY_TEMPLATES])("%s renders a self-contained document that carries its own class and accent", (key) => {
    const doc = documentFixture({ layout: { template: { kind: "builtin", key } } });
    const out = renderPrescription(doc, { ...NO_ASSETS, logo: TINY_PNG, signature: TINY_PNG });
    expect(checkSelfContained(out.html)).toEqual({ ok: true });
    expect(out.html).toContain(`tpl-${key}`);
    expect(out.html).toContain(`--accent:${TEMPLATE_DEFINITIONS[key].accent}`);
  });

  it("freezes the overlay v1 body styles: a gallery key is not a valid flow.bodyStyle", () => {
    const base = MINIMAL_OVERLAY_DEFINITION as unknown as { flow: Record<string, unknown> };
    for (const bodyStyle of BUILTIN_TEMPLATES) {
      expect(overlayDefinitionSchema.safeParse({ ...base, flow: { ...base.flow, bodyStyle } }).success, bodyStyle).toBe(true);
    }
    for (const bodyStyle of GALLERY_TEMPLATES) {
      expect(overlayDefinitionSchema.safeParse({ ...base, flow: { ...base.flow, bodyStyle } }).success, bodyStyle).toBe(false);
    }
  });

  it("is accepted by the frozen snapshot schema as a v1 builtin reference", () => {
    for (const key of GALLERY_TEMPLATES) {
      const doc = documentFixture({ layout: { template: { kind: "builtin", key } } });
      const parsed = renderSnapshotSchema.safeParse(doc.snapshot);
      expect(parsed.success, key).toBe(true);
      expect(doc.snapshot.v, key).toBe(1);
    }
  });
});
