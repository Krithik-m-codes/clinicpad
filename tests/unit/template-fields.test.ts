import { describe, expect, it } from "vitest";
import {
  BOX_FIELD_KEYS,
  FLAG_FIELD_KEYS,
  IMAGE_FIELD_KEYS,
  LIST_FIELD_KEYS,
  RESERVED_FIELD_KEYS,
  TEMPLATE_FIELDS,
  TEXT_FIELD_KEYS,
  fieldType,
} from "@/lib/rx-render/fields";
import { toTemplateData } from "@/lib/rx-render/template-data";
import { DEVANAGARI, HOSTILE, documentFixture, item, snapshot, visit } from "../fixtures/rx-documents";

describe("TEMPLATE_FIELDS", () => {
  it("describes every key exactly once, with its type and both labels", () => {
    const keys = [...BOX_FIELD_KEYS, ...LIST_FIELD_KEYS, ...FLAG_FIELD_KEYS];
    expect(new Set(keys).size).toBe(keys.length);
    expect(Object.keys(TEMPLATE_FIELDS).sort()).toEqual([...keys].sort());
    for (const key of TEXT_FIELD_KEYS) expect(TEMPLATE_FIELDS[key].type).toBe("text");
    for (const key of IMAGE_FIELD_KEYS) expect(TEMPLATE_FIELDS[key].type).toBe("image");
    for (const key of LIST_FIELD_KEYS) expect(TEMPLATE_FIELDS[key].type).toBe("list");
    for (const key of FLAG_FIELD_KEYS) expect(TEMPLATE_FIELDS[key].type).toBe("flag");
    for (const info of Object.values(TEMPLATE_FIELDS)) expect(info.en.trim() && info.hi.trim()).toBeTruthy();
  });

  it("uses the documented names (PRODUCT_SPEC 7.3, ADR-0014)", () => {
    expect(BOX_FIELD_KEYS).toEqual(expect.arrayContaining(["doctor.reg_no", "visit.rx_no", "follow_up.date", "patient.name", "clinic.logo", "doctor.signature"]));
  });

  it("never offers the patient's phone or a QR code, and answers null for unknown or prototype keys", () => {
    for (const key of Object.keys(RESERVED_FIELD_KEYS)) expect(fieldType(key)).toBeNull();
    for (const key of ["constructor", "__proto__", "toString", "patient.name.x", ""]) expect(fieldType(key)).toBeNull();
    expect(fieldType("patient.name")).toBe("text");
  });
});

describe("toTemplateData", () => {
  it("formats the frozen snapshot, the visit and the items with the same helpers as the built-in pads", () => {
    const data = toTemplateData(documentFixture(), "en");
    expect(data.text).toMatchObject({
      "clinic.name": "Sunrise Family Clinic",
      "clinic.address": "12 MG Road\nPune, Maharashtra - 411001",
      "doctor.reg_no": "MMC 2011/04/1234",
      "patient.name": "Asha Rao",
      "patient.age_gender": "36 y / Female",
      "patient.no": "42",
      "patient.allergies": "Penicillin",
      "patient.weight": "70 kg",
      "visit.date": "12/11/2026",
      "visit.rx_no": "12",
      "visit.type": "New visit",
      "vitals.bp": "130/85 mmHg",
      complaints: "Fever, Body ache",
      "follow_up.line": "19/11/2026 · Review CBC report",
    });
    expect(data.text["vitals.line"]).toContain("BP 130/85 mmHg");
    expect(data.lists.medicines[0]).toMatchObject({ n: "1", name: "Medicine 1" });
    expect(data.lists.tests).toEqual([
      { n: "1", name: "CBC", instructions: "" },
      { n: "2", name: "Dengue NS1", instructions: "If fever persists" },
    ]);
    expect(data.flags).toMatchObject({ "has.allergies": true, "has.medicines": true, "has.tests": true, "has.follow_up": true });
  });

  it("prints blanks as empty strings, never undefined or null", () => {
    const doc = documentFixture({
      snapshot: snapshot({ patient: { gender: null, patientNo: null, allergies: [], ageLabel: "" }, doctor: { registrationNo: null, qualifications: null } }),
      visit: visit({ chiefComplaint: null, advice: null, followUpDate: null, followUpReason: null, vitals: {}, investigations: [] }),
      items: [],
    });
    const data = toTemplateData(doc, "en");
    for (const [key, value] of Object.entries(data.text)) {
      expect(typeof value, key).toBe("string");
      expect(value, key).not.toMatch(/undefined|null|NaN/);
    }
    expect(data.text["patient.age_gender"]).toBe("");
    expect(data.flags).toMatchObject({ "has.allergies": false, "has.vitals": false, "has.medicines": false, "has.tests": false, "has.follow_up": false });
  });

  it("never gives a draft an Rx number or a signature", () => {
    const draft = documentFixture({ status: "draft", rxNo: 12, issuedAt: null, snapshot: snapshot({ doctor: { signatureAssetId: "019a0000-0000-7000-8000-000000000001" } }) });
    const data = toTemplateData(draft, "en");
    expect(data.text["visit.rx_no"]).toBe("");
    expect(data.flags["has.signature"]).toBe(false);
  });

  it("shows the version on later versions and localises coded values", () => {
    const v2 = toTemplateData(documentFixture({ version: 2 }), "hi");
    expect(v2.text["visit.rx_no"]).toBe("12 (v2)");
    expect(v2.text["patient.age"]).toBe("36 वर्ष");
    expect(toTemplateData(documentFixture(), "bilingual").text["patient.gender"]).toBe("Female / महिला");
  });

  it("keeps hostile and Devanagari text as plain text (escaping is the renderer's job)", () => {
    const data = toTemplateData(documentFixture({ snapshot: snapshot({ patient: { name: HOSTILE.script + DEVANAGARI.name } }), items: [item(1, { drugName: HOSTILE.img })] }), "en");
    expect(data.text["patient.name"]).toBe(HOSTILE.script + DEVANAGARI.name);
    expect(data.lists.medicines[0].name).toBe(HOSTILE.img);
  });

  it("reads only the frozen snapshot, visit and items: stray row columns never reach a field (Plan 2A overrides 13, 16)", () => {
    const base = documentFixture();
    const stray = { phone: "STRAY-PHONE", tenantId: "STRAY-TENANT", email: "stray@example.test", id: "STRAY-ID" };
    const doc = documentFixture({
      snapshot: { ...base.snapshot, patient: { ...base.snapshot.patient, ...stray }, doctor: { ...base.snapshot.doctor, ...stray } },
    });
    const data = toTemplateData(doc, "en");
    const printed = JSON.stringify(data);
    expect(printed).not.toMatch(/STRAY/);
    expect(printed).not.toMatch(/stray@example/);
    expect(Object.keys(data.text).sort()).toEqual([...TEXT_FIELD_KEYS].sort());
  });
});
