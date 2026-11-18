import { describe, expect, it } from "vitest";
import { SAMPLE_DOCTOR, SAMPLE_KINDS, sampleDocument } from "@/lib/rx-render/samples";
import { toTemplateData } from "@/lib/rx-render/template-data";
import { snapshot } from "../fixtures/rx-documents";

const base = snapshot({ doctor: { signatureAssetId: "019a0000-0000-7000-8000-000000000001" } });

describe("sampleDocument", () => {
  it("keeps the clinic's own letterhead but never a real doctor, Rx number or signature", () => {
    for (const kind of SAMPLE_KINDS) {
      const doc = sampleDocument(kind, base);
      expect(doc.snapshot.clinic).toEqual(base.clinic);
      expect(doc.snapshot.doctor.name).not.toBe(base.doctor.name);
      expect(doc.snapshot.doctor.registrationNo).not.toBe(base.doctor.registrationNo);
      expect(doc.snapshot.doctor.name).toBe(SAMPLE_DOCTOR.name);
      expect(doc.rxNo).toBeNull();
      expect(toTemplateData(doc, "en").text["visit.rx_no"]).toBe("");
      expect(toTemplateData(doc, "en").flags["has.signature"]).toBe(false);
      expect(doc.snapshot.doctor.signatureAssetId).toBeNull();
      expect(doc.snapshot.layout).toEqual(base.layout);
    }
  });

  it("gives the short sample 3 medicines, the long one 12 with Devanagari text, and the blank one nothing", () => {
    expect(sampleDocument("short", base).items).toHaveLength(3);
    const long = sampleDocument("long", base);
    expect(long.items).toHaveLength(12);
    expect(long.snapshot.patient.name).toMatch(/[\u0900-\u097F]/);
    const blank = toTemplateData(sampleDocument("blank", base), "en");
    expect(blank.text["patient.name"]).toBe("");
    expect(blank.text["visit.rx_no"]).toBe("");
    expect(blank.lists.medicines).toHaveLength(0);
  });

  it("is deterministic", () => {
    expect(JSON.stringify(sampleDocument("long", base))).toBe(JSON.stringify(sampleDocument("long", base)));
  });
});
