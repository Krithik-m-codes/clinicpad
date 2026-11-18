import { describe, expect, it } from "vitest";
import { translations } from "@/lib/translations";
import {
  ageText,
  durationText,
  foodText,
  genderText,
  labelHtml,
  labelText,
  LABELS,
  periodicityText,
  type LabelKey,
} from "@/lib/rx-render/labels";
import {
  bmiText,
  bpText,
  formatCalendarDate,
  formatIssuedDate,
  hasSlots,
  numberText,
  pdfFileName,
  quantityText,
  scheduleText,
} from "@/lib/rx-render/format";
import { parseRenderSnapshot, type RenderSnapshot } from "@/lib/rx-render/snapshot";
import { PAD_LIMITS, clinicPadSchema } from "@/server/validation/pad-settings";
import { PAPER } from "@/lib/rx-render/paper";
import { BUILTIN_TEMPLATES, pickOption } from "@/lib/rx-render/types";
import { DEVANAGARI, HOSTILE, documentFixture, item, snapshot } from "../fixtures/rx-documents";

const BAD_WORDS = /NaN|undefined|null|Infinity|(^|[\s/])-0(\D|$)|e\+\d/;

describe("labels", () => {
  it("prints English, Hindi, or both", () => {
    expect(labelText("diagnosis", "en")).toBe("Diagnosis");
    expect(labelText("diagnosis", "hi")).toBe(translations.hindi.diagnosis);
    expect(labelText("diagnosis", "bilingual")).toBe(`Diagnosis / ${translations.hindi.diagnosis}`);
  });

  it("stacks bilingual table headings and escapes nothing unexpected", () => {
    expect(labelHtml("medicine", "en").value).toBe("Medicine");
    expect(labelHtml("medicine", "bilingual").value).toBe(
      `<span class="l-en">Medicine</span><span class="l-hi">${translations.hindi.medicine}</span>`,
    );
  });

  it("translates coded values and keeps unknown codes as text", () => {
    expect(foodText("after", "en")).toBe("After food");
    expect(foodText("after", "hi")).toBe(translations.hindi.after);
    expect(foodText("after", "bilingual")).toBe(`After food / ${translations.hindi.after}`);
    expect(foodText("sometimes", "hi")).toBe("sometimes");
    expect(foodText(null, "en")).toBe("");
    expect(periodicityText("alternate_day", "hi")).toBe(translations.hindi.alternate);
    expect(periodicityText("twice_weekly", "en")).toBe("Twice a week");
    expect(genderText("female", "hi")).toBe(translations.hindi.female);
    expect(genderText("unknown", "en")).toBe("");
    expect(genderText(null, "en")).toBe("");
  });

  it("has English and Hindi text for every label, and never prints identical text twice", () => {
    const keys = Object.keys(LABELS) as LabelKey[];
    expect(keys.length).toBeGreaterThan(30);
    for (const key of keys) {
      expect(LABELS[key].en.trim(), key).not.toBe("");
      expect(LABELS[key].hi.trim(), key).not.toBe("");
      const same = LABELS[key].en === LABELS[key].hi;
      expect(labelText(key, "bilingual"), key).toBe(same ? LABELS[key].en : `${LABELS[key].en} / ${LABELS[key].hi}`);
      expect(labelHtml(key, "bilingual").value.includes("l-hi"), key).toBe(!same);
    }
    expect(labelText("spo2", "bilingual")).toBe("SpO2");
    expect(labelText("bmi", "bilingual")).toBe("BMI");
    expect(labelHtml("bmi", "bilingual").value).toBe("BMI");
  });

  it("calls the follow-up heading a follow-up, not the next-visit wording", () => {
    expect(labelText("followUp", "hi")).not.toBe(translations.hindi.followUpDate);
  });

  it("does not treat inherited object keys as known codes", () => {
    expect(foodText("__proto__", "en")).toBe("__proto__");
    expect(foodText("constructor", "hi")).toBe("constructor");
    expect(genderText("toString", "en")).toBe("");
  });

  it("writes durations and ages in the label language", () => {
    expect(durationText(5, "days", "hi")).toBe("5 दिन");
    expect(durationText(1, "months", "hi")).toBe("1 महीना");
    expect(durationText(3, "months", "hi")).toBe("3 महीने");
    expect(durationText(2, "weeks", "en")).toBe("2 weeks");
    expect(durationText(2, "weeks", "bilingual")).toBe("2 weeks / 2 सप्ताह");
    expect(durationText(null, "days", "en")).toBe("");
    // An unknown or missing unit prints nothing (never a guessed "days").
    for (const unit of ["years", "", "__proto__", "constructor"]) expect(durationText(3, unit, "bilingual")).toBe("");
    expect(ageText("6 y", "hi")).toBe("6 वर्ष");
    expect(ageText("15 mo", "hi")).toBe("15 माह");
    expect(ageText("11 d", "hi")).toBe("11 दिन");
    expect(ageText("6 y", "en")).toBe("6 y");
    expect(ageText("", "hi")).toBe("");
  });

  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
    ["zero", 0],
    ["negative zero", -0],
    ["negative", -3],
    ["huge", 1e21],
    ["above the cap", 10000],
  ])("prints no duration for %s", (_label, value) => {
    expect(durationText(value, "days", "bilingual")).toBe("");
  });

  it("keeps durations short and readable", () => {
    expect(durationText(1.5, "weeks", "en")).toBe("1.5 weeks");
    expect(durationText(1 / 3, "days", "en")).toBe("0.33 days");
    expect(durationText(0.001, "days", "en")).toBe("");
    expect(durationText(7, "fortnights", "en")).toBe("");
    expect(durationText(7, null, "hi")).toBe("7 दिन");
  });
});

describe("format", () => {
  it("prints the issue date in the clinic's timezone", () => {
    expect(formatIssuedDate("2026-11-12T20:00:00.000Z", "Asia/Kolkata")).toBe("13/11/2026");
    expect(formatIssuedDate("2026-11-12T20:00:00.000Z", "Mars/Olympus")).toBe("13/11/2026");
    expect(formatIssuedDate("yesterday", "Asia/Kolkata")).toBe("");
  });

  it("uses the zone passed in, not the machine's", () => {
    const instant = "2026-12-31T20:00:00.000Z";
    expect(formatIssuedDate(instant, "Asia/Kolkata")).toBe("01/01/2027");
    expect(formatIssuedDate(instant, "America/Los_Angeles")).toBe("31/12/2026");
    expect(formatIssuedDate(instant, "Pacific/Auckland")).toBe("01/01/2027");
    expect(formatIssuedDate(instant, "UTC")).toBe("31/12/2026");
    // a missing or damaged zone means the product default (IST), never UTC
    for (const bad of ["", "   ", "garbage", "Mars/Olympus", undefined, null]) {
      expect(formatIssuedDate(instant, bad)).toBe("01/01/2027");
    }
    expect(formatIssuedDate("2026-11-12T20:00:00.000Z", 5 as unknown as string)).toBe("13/11/2026");
  });

  it("refuses implausible instants", () => {
    expect(formatIssuedDate("+275760-09-13T00:00:00.000Z", "Asia/Kolkata")).toBe("");
    expect(formatIssuedDate("1850-01-01T00:00:00.000Z", "Asia/Kolkata")).toBe("");
    expect(formatIssuedDate("", "Asia/Kolkata")).toBe("");
  });

  it("prints calendar dates day first", () => {
    expect(formatCalendarDate("2026-12-01")).toBe("01/12/2026");
    expect(formatCalendarDate("01/12/2026")).toBe("");
    expect(formatCalendarDate(null)).toBe("");
    expect(formatCalendarDate("2026-02-31")).toBe("");
    expect(formatCalendarDate("2026-13-01")).toBe("");
    expect(formatCalendarDate("2028-02-29")).toBe("29/02/2028");
    expect(formatCalendarDate("2027-02-29")).toBe("");
  });

  it.each([
    [null, "0"],
    [0, "0"],
    [1, "1"],
    [0.5, "½"],
    [1.5, "1½"],
    [0.25, "¼"],
    [2.75, "2¾"],
    [12, "12"],
    [0.3, "0.3"],
  ])("prints a dose of %j as %s", (q, expected) => {
    expect(quantityText(q)).toBe(expected);
  });

  it.each([
    ["NaN", Number.NaN, "0"],
    ["Infinity", Number.POSITIVE_INFINITY, "0"],
    ["-Infinity", Number.NEGATIVE_INFINITY, "0"],
    ["negative zero", -0, "0"],
    ["negative", -2, "0"],
    ["one third", 1 / 3, "0.33"],
    ["two thirds", 2 / 3, "0.67"],
    ["a float tail", 0.1 + 0.2, "0.3"],
    ["a tiny positive", 0.0001, "0"],
    ["huge", 1e21, "999+"],
    ["just over the cap", 1000, "999+"],
    ["at the cap", 999, "999"],
    ["rounds to a quarter", 0.249, "¼"],
  ])("never prints garbage for a dose of %s", (_label, q, expected) => {
    const text = quantityText(q);
    expect(text).toBe(expected);
    expect(text).not.toMatch(BAD_WORDS);
  });

  it("uses the slot pattern when there is one, else the free-text timing", () => {
    expect(hasSlots(item(1))).toBe(true);
    expect(scheduleText(item(1))).toBe("1-0-1");
    const free = item(2, { doseMorning: null, doseAfternoon: null, doseEvening: null, doseNight: null, timing: "SOS" });
    expect(hasSlots(free)).toBe(false);
    expect(scheduleText(free)).toBe("SOS");
    expect(scheduleText(item(3, { doseMorning: 0, doseAfternoon: 0, doseEvening: null, doseNight: 0, timing: null }))).toBe("");
  });

  it("prints the four-slot form only when there is an evening dose", () => {
    expect(scheduleText(item(1, { doseMorning: 1, doseAfternoon: 1, doseEvening: 1, doseNight: 1 }))).toBe("1-1-1-1");
    expect(scheduleText(item(1, { doseMorning: 0.5, doseAfternoon: 0, doseEvening: 0, doseNight: 0.5 }))).toBe("½-0-½");
    expect(scheduleText(item(1, { doseMorning: 1, doseAfternoon: 0, doseEvening: 1.5, doseNight: 0 }))).toBe("1-0-1½-0");
  });

  it("treats a dose that prints as 0 as no dose, so the free-text timing shows", () => {
    const tiny = item(1, { doseMorning: 0.0001, doseAfternoon: 0.004, doseEvening: null, doseNight: 0, timing: "as directed" });
    expect(hasSlots(tiny)).toBe(false);
    expect(scheduleText(tiny)).toBe("as directed");
    expect(hasSlots(item(1, { doseMorning: 0.005, doseAfternoon: 0, doseEvening: null, doseNight: 0 }))).toBe(true);
    expect(scheduleText(item(1, { doseMorning: 0.005, doseAfternoon: 0, doseEvening: null, doseNight: 0 }))).toBe("0.01-0-0");
  });

  it("never prints garbage for damaged slot values", () => {
    const damaged = item(1, {
      doseMorning: Number.NaN,
      doseAfternoon: -1,
      doseEvening: Number.POSITIVE_INFINITY,
      doseNight: 1 / 3,
      timing: "  as directed  ",
    });
    expect(hasSlots(damaged)).toBe(true);
    expect(scheduleText(damaged)).toBe("0-0-0.33");
    const none = item(1, { doseMorning: Number.NaN, doseAfternoon: -0, doseEvening: -5, doseNight: Number.NEGATIVE_INFINITY, timing: " after stool " });
    expect(hasSlots(none)).toBe(false);
    expect(scheduleText(none)).toBe("after stool");
    expect(scheduleText({ ...none, timing: "   " })).toBe("");
    expect(scheduleText({ ...none, timing: null })).toBe("");
    for (const text of [scheduleText(damaged), scheduleText(none)]) expect(text).not.toMatch(BAD_WORDS);
  });

  it.each([
    [70, 0],
    [null, 175],
    [70, null],
    [Number.NaN, 175],
    [70, Number.POSITIVE_INFINITY],
    [-70, 175],
  ])("prints no BMI for unusable input %j / %j", (weight, height) => {
    expect(bmiText(weight, height)).toBe("");
  });

  it("prints vitals as short plain numbers", () => {
    expect(bmiText(70, 175)).toBe("22.9");
    expect(numberText(100.4)).toBe("100.4");
    expect(numberText(100)).toBe("100");
    expect(numberText(97.04)).toBe("97");
    expect(numberText(-0)).toBe("0");
    expect(numberText(-0.04)).toBe("0");
    expect(numberText(0.1 + 0.2)).toBe("0.3");
    expect(numberText(1 / 3, 2)).toBe("0.33");
    for (const bad of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1e21, 1e7]) {
      expect(numberText(bad)).toBe("");
    }
    expect(bpText(130, 85)).toBe("130/85");
    expect(bpText(130.4, 84.6)).toBe("130/85");
    expect(bpText(130, undefined)).toBe("");
    expect(bpText(0, 85)).toBe("");
    expect(bpText(-130, 85)).toBe("");
    expect(bpText(Number.NaN, 85)).toBe("");
  });

  it("names PDFs without patient data", () => {
    expect(pdfFileName({ rxNo: 12, version: 2, status: "finalized" })).toBe("Rx-12-v2.pdf");
    expect(pdfFileName({ rxNo: null, version: 1, status: "finalized" })).toBe("Rx-draft-v1.pdf");
    expect(pdfFileName({ rxNo: Number.NaN, version: Number.NaN, status: "finalized" })).toBe("Rx-draft-v1.pdf");
    expect(pdfFileName({ rxNo: -4, version: 0, status: "finalized" })).toBe("Rx-draft-v1.pdf");
    expect(pdfFileName({ rxNo: 1e21, version: 1.5, status: "finalized" })).toBe("Rx-draft-v1.pdf");
  });

  it("never numbers a draft, even an amendment draft that carries its parent's number", () => {
    expect(pdfFileName({ rxNo: 12, version: 2, status: "draft" })).toBe("Rx-draft-v2.pdf");
    expect(pdfFileName({ rxNo: 12, version: 2, status: "finalized" })).toBe("Rx-12-v2.pdf");
    expect(pdfFileName({ rxNo: 12, version: 1, status: "amended" })).toBe("Rx-12-v1.pdf");
  });
});

describe("render snapshot schema", () => {
  it("round-trips a snapshot and drops unknown keys", () => {
    const value = { ...snapshot(), extra: "ignored" };
    expect(parseRenderSnapshot(value)).toEqual(snapshot());
  });

  it("round-trips hostile and Devanagari text unchanged", () => {
    const value = snapshot({
      patient: { name: HOSTILE.script + HOSTILE.bidi, allergies: [HOSTILE.loneSurrogate, DEVANAGARI.conjuncts] },
      clinic: { name: HOSTILE.script, footerLines: [HOSTILE.urls, HOSTILE.long5000] },
    });
    expect(parseRenderSnapshot(JSON.parse(JSON.stringify(value)))).toEqual(value);
  });

  const longText = "x".repeat(5000);

  it("round-trips strings at their limits", () => {
    const value = snapshot({
      patient: { name: "n".repeat(200), allergies: Array.from({ length: 50 }, () => "a".repeat(200)) },
      clinic: { footerLines: [longText], timezone: "America/New_York" },
      doctor: { qualifications: "q".repeat(200) },
    });
    expect(parseRenderSnapshot(value)).toEqual(value);
  });

  it("accepts every value the write side can save (snapshot limits >= write-side limits)", () => {
    const text = (n: number) => "x".repeat(n);
    // Clinic and doctor limits come from the real write-side schema table; the patient ones are still literals.
    const L = PAD_LIMITS;
    const cases: Array<[string, number, (n: number) => RenderSnapshot]> = [
      ["patient name 120", 120, (n) => snapshot({ patient: { name: text(n) } })],
      ["allergy entry 80", 80, (n) => snapshot({ patient: { allergies: [text(n)] } })],
      ["clinic name", L.clinicName, (n) => snapshot({ clinic: { name: text(n) } })],
      ["clinic phone", L.phone, (n) => snapshot({ clinic: { phone: text(n) } })],
      ["clinic email", L.email, (n) => snapshot({ clinic: { email: text(n) } })],
      ["footer", L.footerChars, (n) => snapshot({ clinic: { footerLines: [text(n)] } })],
      ["address line", L.addressLine, (n) => snapshot({ clinic: { addressLines: [text(n)] } })],
      ["doctor name", L.doctorName, (n) => snapshot({ doctor: { name: text(n) } })],
      ["qualifications", L.qualifications, (n) => snapshot({ doctor: { qualifications: text(n) } })],
      ["designation", L.designation, (n) => snapshot({ doctor: { designation: text(n) } })],
      ["registration", L.registrationNo, (n) => snapshot({ doctor: { registrationNo: text(n) } })],
      ["council", L.registrationCouncil, (n) => snapshot({ doctor: { registrationCouncil: text(n) } })],
    ];
    for (const [label, limit, build] of cases) {
      expect(parseRenderSnapshot(build(limit)), label).not.toBeNull();
    }
    const twentyAllergies = snapshot({ patient: { allergies: Array.from({ length: 20 }, () => text(80)) } });
    expect(parseRenderSnapshot(twentyAllergies)).not.toBeNull();
    const fourFooterLines = snapshot({ clinic: { footerLines: Array.from({ length: PAD_LIMITS.footerLines }, () => text(150)) } });
    expect(parseRenderSnapshot(fourFooterLines)).not.toBeNull();
  });

  it("keeps the composed 'city, state - pincode' address line within the snapshot line limit", () => {
    const longest = `${"c".repeat(PAD_LIMITS.city)}, ${"s".repeat(PAD_LIMITS.state)} - ${"9".repeat(PAD_LIMITS.pincode)}`;
    expect(longest.length).toBeLessThanOrEqual(200);
    expect(parseRenderSnapshot(snapshot({ clinic: { addressLines: [longest] } }))).not.toBeNull();
    expect(clinicPadSchema.safeParse({ name: "Clinic", pincode: "9".repeat(PAD_LIMITS.pincode) }).success).toBe(true);
    expect(clinicPadSchema.safeParse({ name: "Clinic", pincode: "9".repeat(PAD_LIMITS.pincode + 1) }).success).toBe(false);
  });

  it("bounds the clinic phone at 200 characters", () => {
    expect(parseRenderSnapshot(snapshot({ clinic: { phone: "9".repeat(80) } }))).not.toBeNull();
    expect(parseRenderSnapshot(snapshot({ clinic: { phone: "9".repeat(200) } }))).not.toBeNull();
    expect(parseRenderSnapshot(snapshot({ clinic: { phone: "9".repeat(201) } }))).toBeNull();
  });

  it("accepts what toISOString writes and valid ids", () => {
    const id = "01927f3e-5b6a-7c2d-8e1f-0a1b2c3d4e5f"; // a UUIDv7
    const value = snapshot({ clinic: { logoAssetId: id }, doctor: { signatureAssetId: id } });
    value.takenAt = new Date("2026-11-12T05:30:00Z").toISOString();
    expect(parseRenderSnapshot(value)).toEqual(value);
    expect(parseRenderSnapshot({ ...value, takenAt: "2026-11-12T11:00:00+05:30" })).not.toBeNull();
  });

  it.each([
    ["a non-ISO takenAt", (s: RenderSnapshot) => ({ ...s, takenAt: "12 Nov 2026" })],
    ["a date-only takenAt", (s: RenderSnapshot) => ({ ...s, takenAt: "2026-11-12" })],
    ["a non-string takenAt", (s: RenderSnapshot) => ({ ...s, takenAt: 1700000000000 })],
    ["a day-first dob", (s: RenderSnapshot) => ({ ...s, patient: { ...s.patient, dob: "02/04/1990" } })],
    ["an impossible dob", (s: RenderSnapshot) => ({ ...s, patient: { ...s.patient, dob: "1990-02-30" } })],
    ["an unknown time zone", (s: RenderSnapshot) => ({ ...s, clinic: { ...s.clinic, timezone: "Mars/Olympus" } })],
    ["an empty time zone", (s: RenderSnapshot) => ({ ...s, clinic: { ...s.clinic, timezone: "" } })],
    ["a non-uuid logo id", (s: RenderSnapshot) => ({ ...s, clinic: { ...s.clinic, logoAssetId: "logo-1" } })],
    ["a non-uuid signature id", (s: RenderSnapshot) => ({ ...s, doctor: { ...s.doctor, signatureAssetId: "../../etc/passwd" } })],
    ["a name over 200 characters", (s: RenderSnapshot) => ({ ...s, patient: { ...s.patient, name: "n".repeat(201) } })],
    ["a footer line over 5,000 characters", (s: RenderSnapshot) => ({ ...s, clinic: { ...s.clinic, footerLines: ["x".repeat(5001)] } })],
    ["more than 50 allergies", (s: RenderSnapshot) => ({ ...s, patient: { ...s.patient, allergies: Array.from({ length: 51 }, () => "a") } })],
    ["more than 10 address lines", (s: RenderSnapshot) => ({ ...s, clinic: { ...s.clinic, addressLines: Array.from({ length: 11 }, () => "a") } })],
  ])("rejects %s without throwing", (_label, damage) => {
    expect(parseRenderSnapshot(damage(snapshot()))).toBeNull();
  });

  it.each([
    ["a future version", { ...snapshot(), v: 2 }],
    ["a missing patient", { ...snapshot(), patient: undefined }],
    ["an unknown template", { ...snapshot(), layout: { template: { kind: "builtin", key: "fancy" }, paperSize: "A4", labels: "en" } }],
    ["a DOCX template (Phase 2 only)", { ...snapshot(), layout: { template: { kind: "docx", key: "general" }, paperSize: "A4", labels: "en" } }],
    ["a non-object", "snapshot"],
    ["null", null],
    ["a fractional patient number", { ...snapshot(), patient: { ...snapshot().patient, patientNo: 1.5 } }],
  ])("rejects %s", (_label, value) => {
    expect(parseRenderSnapshot(value)).toBeNull();
  });
});

describe("paper and options", () => {
  it("defines A4 and A5 in millimetres and inches", () => {
    expect(PAPER.A4).toMatchObject({ widthMm: 210, heightMm: 297, widthIn: 8.27, heightIn: 11.69 });
    expect(PAPER.A5).toMatchObject({ widthMm: 148, heightMm: 210, widthIn: 5.83, heightIn: 8.27 });
  });

  it("falls back for unknown option values", () => {
    expect(pickOption(BUILTIN_TEMPLATES, "derma", "general")).toBe("derma");
    expect(pickOption(BUILTIN_TEMPLATES, "fancy", "general")).toBe("general");
    expect(pickOption(BUILTIN_TEMPLATES, null, "general")).toBe("general");
    expect(pickOption(BUILTIN_TEMPLATES, "__proto__", "general")).toBe("general");
  });
});

describe("fixtures", () => {
  const count = (text: string) => Array.from(text).length;

  it("keeps non-printing characters as real code points, not re-encoded text", () => {
    expect(Array.from(HOSTILE.bidi).map((c) => c.codePointAt(0))).toEqual([0x202e, 0x65, 0x76, 0x69, 0x6c, 0x202c]);
    expect(Array.from(HOSTILE.controls).map((c) => c.codePointAt(0))).toEqual([0x61, 0, 0x62, 7, 0x63, 0x1f, 0x64]);
    expect(HOSTILE.loneSurrogate.length).toBe(5);
    expect(HOSTILE.loneSurrogate.charCodeAt(1)).toBe(0xd800);
    expect(HOSTILE.loneSurrogate.charCodeAt(3)).toBe(0xdc00);
    expect(DEVANAGARI.conjuncts.includes("\u200D")).toBe(true);
    expect(DEVANAGARI.conjuncts.includes("\u200C")).toBe(true);
    expect(Array.from(DEVANAGARI.conjuncts.slice(0, 5)).map((c) => c.codePointAt(0))).toEqual([0x915, 0x94d, 0x200d, 0x937, 0x20]);
    expect(count(HOSTILE.long5000)).toBe(5000);
    expect(DEVANAGARI.conjuncts.split("\u200D")).toHaveLength(2);
    expect(DEVANAGARI.conjuncts.split("\u200C")).toHaveLength(2);
    expect(Array.from(DEVANAGARI.conjuncts)).toHaveLength(21);
    expect(DEVANAGARI.advice.split(" ").length).toBeGreaterThan(300);
    expect(DEVANAGARI.advice.startsWith("भोजन के बाद")).toBe(true);
    expect(count(HOSTILE.longWord)).toBe(2000);
  });

  it("builds a finalized General A4 document that parses back through the schema", () => {
    const doc = documentFixture();
    expect(parseRenderSnapshot(doc.snapshot)).toEqual(doc.snapshot);
    expect(doc.items).toHaveLength(3);
    expect(documentFixture({ layout: { paperSize: "A5", labels: "hi" } }).snapshot.layout).toMatchObject({ paperSize: "A5", labels: "hi" });
  });
});
