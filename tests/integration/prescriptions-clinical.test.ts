import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPatient } from "@/server/services/patients";
import {
  finalizePrescription,
  getPrescription,
  saveDraft,
  startPrescription,
} from "@/server/services/prescriptions";
import { createTestTenant, type TestTenant } from "../helpers/tenant";

let A: TestTenant;
let B: TestTenant;
let patientId = "";
const doctor = () => A.as("doctor");

const fullDraft = () => ({
  visitType: "follow-up",
  chiefComplaint: "Fever for 3 days",
  complaints: ["Fever", "Body ache"],
  diagnosis: ["Viral fever"],
  medicalHistory: ["DM", "HT"],
  drugHistory: ["Metformin 500"],
  examinationNotes: "Throat congested. Chest clear.",
  vitals: {
    bpSystolic: 130,
    bpDiastolic: 85,
    pulse: 92,
    temperatureF: 100.4,
    spo2: 97,
    respiratoryRate: 18,
    weightKg: 72.5,
    heightCm: 170,
    bloodSugarMgDl: 140,
    notes: "RBS",
  },
  investigations: [{ name: "CBC", instructions: "Fasting not needed" }, { name: "Dengue NS1" }],
  advice: "Plenty of fluids",
  followUpDate: "2026-12-01",
  followUpReason: "Review CBC report",
  items: [
    {
      drugName: "DOLO 650MG",
      genericName: "Paracetamol 650Mg",
      strength: "650 mg",
      dose: "1 tab",
      doseMorning: 1,
      doseAfternoon: 0,
      doseEvening: null,
      doseNight: 1,
      foodRelation: "after",
      periodicity: "daily",
      isSos: false,
      durationValue: 5,
      durationUnit: "days",
      remarks: "If fever above 100",
    },
    { drugName: "Cetirizine", doseNight: 0.5, isSos: true, durationValue: 2, durationUnit: "weeks" },
  ],
});

beforeAll(async () => {
  A = await createTestTenant("clina");
  B = await createTestTenant("clinb");
  const p = await createPatient(A.as("reception"), { name: "Clinical Patient" });
  if (!p.ok) throw new Error(p.message);
  patientId = p.value.id;
});

afterAll(async () => {
  await A.cleanup();
  await B.cleanup();
});

async function start(): Promise<string> {
  const r = await startPrescription(doctor(), { patientId });
  if (!r.ok) throw new Error(r.message);
  return r.value.prescriptionId;
}

async function read(id: string) {
  const got = await getPrescription(doctor(), id);
  if (!got.ok) throw new Error(got.message);
  return got.value;
}

describe("saveDraft with the clinical form", () => {
  it("stores and returns every clinical field", async () => {
    const id = await start();
    expect(await saveDraft(doctor(), id, fullDraft())).toMatchObject({ ok: true, value: { revision: 1 } });

    const got = await getPrescription(A.as("nurse"), id); // nurses can read
    if (!got.ok) throw new Error(got.message);
    const rx = got.value;
    expect(rx.revision).toBe(1);
    expect(rx.visit).toMatchObject({
      visitType: "follow-up",
      chiefComplaint: "Fever for 3 days",
      complaints: ["Fever", "Body ache"],
      diagnosis: ["Viral fever"],
      medicalHistory: ["DM", "HT"],
      drugHistory: ["Metformin 500"],
      examinationNotes: "Throat congested. Chest clear.",
      investigations: [{ name: "CBC", instructions: "Fasting not needed" }, { name: "Dengue NS1" }],
      advice: "Plenty of fluids",
      followUpDate: "2026-12-01",
      followUpReason: "Review CBC report",
    });
    expect(rx.visit.vitals).toEqual(fullDraft().vitals);
    expect(rx.items[0]).toEqual({
      drugName: "DOLO 650MG",
      genericName: "Paracetamol 650Mg",
      strength: "650 mg",
      form: null,
      route: null,
      dose: "1 tab",
      doseMorning: 1,
      doseAfternoon: 0,
      doseEvening: null,
      doseNight: 1,
      timing: null,
      foodRelation: "after",
      periodicity: "daily",
      isSos: false,
      durationValue: 5,
      durationUnit: "days",
      durationDays: 5,
      remarks: "If fever above 100",
    });
    expect(rx.items[1]).toMatchObject({ doseNight: 0.5, isSos: true, durationValue: 2, durationUnit: "weeks", durationDays: 14 });
  });

  it("still accepts the Plan 1A item shape and reads it as a duration in days", async () => {
    const id = await start();
    await saveDraft(doctor(), id, { items: [{ drugName: "Paracetamol", timing: "TDS", durationDays: 3 }] });
    expect((await read(id)).items[0]).toMatchObject({
      timing: "TDS",
      durationValue: 3,
      durationUnit: "days",
      durationDays: 3,
      isSos: false,
    });
  });

  it("drops repeated phrases ignoring case and keeps the first spelling", async () => {
    const id = await start();
    await saveDraft(doctor(), id, { complaints: ["Fever", "fever", " FEVER ", "Cough"], investigations: [{ name: "CBC" }, { name: "cbc" }] });
    const rx = await read(id);
    expect(rx.visit.complaints).toEqual(["Fever", "Cough"]);
    expect(rx.visit.investigations).toEqual([{ name: "CBC" }]);
  });

  it("stores hostile-looking text verbatim as plain text, minus stray control characters", async () => {
    const id = await start();
    const BELL = "\u0007"; // a stray control character from a paste, written as an escape
    expect([...BELL]).toHaveLength(1);
    await saveDraft(doctor(), id, {
      chiefComplaint: "<script>alert(1)</script>",
      advice: `line1\r\nline2${BELL}`,
      complaints: ["आशा को बुखार"],
      items: [{ drugName: '<img src=x onerror="alert(1)">' }],
    });
    const rx = await read(id);
    expect(rx.visit.chiefComplaint).toBe("<script>alert(1)</script>");
    expect(rx.visit.advice).toBe("line1\nline2");
    expect(rx.visit.complaints).toEqual(["आशा को बुखार"]);
    expect(rx.items[0].drugName).toBe('<img src=x onerror="alert(1)">');
  });

  it("drops blank phrase entries instead of rejecting the whole save", async () => {
    const id = await start();
    const saved = await saveDraft(doctor(), id, {
      diagnosis: ["", "   ", "\u0007", "Viral fever"],
      complaints: [" "],
      drugHistory: ["\t"],
    });
    expect(saved.ok).toBe(true);
    const rx = await read(id);
    expect(rx.visit.diagnosis).toEqual(["Viral fever"]);
    expect(rx.visit.complaints).toEqual([]);
    expect(rx.visit.drugHistory).toEqual([]);
  });

  describe("a NUL character in the new free-text fields", () => {
    // Written as an escape so the file holds no invisible character; the first test proves it is one code point.
    const NUL = "\u0000";
    const bad = `bad${NUL}text`;

    it("is a single code point", () => {
      expect([...NUL]).toHaveLength(1);
      expect(NUL.codePointAt(0)).toBe(0);
    });

    it.each([
      ["a complaint", "complaints", { complaints: ["Fine", bad] }],
      ["a lone NUL complaint", "complaints", { complaints: [NUL] }],
      ["medical history", "medicalHistory", { medicalHistory: [bad] }],
      ["examination notes", "examinationNotes", { examinationNotes: bad }],
      ["vitals notes", "vitals", { vitals: { notes: bad } }],
      ["a test name", "investigations", { investigations: [{ name: bad }] }],
      ["test instructions", "investigations", { investigations: [{ name: "CBC", instructions: bad }] }],
      ["the follow-up reason", "followUpReason", { followUpReason: bad }],
      ["a generic name", "items", { items: [{ drugName: "X", genericName: bad }] }],
    ])("is refused in %s as invalid, never silently stripped", async (_name, field, input) => {
      const id = await start();
      expect((await saveDraft(doctor(), id, { advice: "Before" })).ok).toBe(true);
      expect(await saveDraft(doctor(), id, input)).toMatchObject({ ok: false, code: "invalid", field });
      expect((await read(id)).visit.advice).toBe("Before");
    });
  });

  describe("a lone UTF-16 surrogate (for example an emoji sliced by code unit)", () => {
    const LONE = "\ud800";
    const EMOJI = "😀";

    it("is a single code unit and the emoji is a single code point", () => {
      expect(LONE).toHaveLength(1);
      expect([...EMOJI]).toHaveLength(1);
    });

    it("is removed from jsonb text (vitals notes, test name, test instructions), not a server error", async () => {
      const id = await start();
      const saved = await saveDraft(doctor(), id, {
        vitals: { pulse: 80, notes: `a${LONE}b` },
        investigations: [{ name: `C${LONE}BC`, instructions: `fast${LONE}ing` }],
      });
      expect(saved.ok).toBe(true);
      const rx = await read(id);
      expect(rx.visit.vitals).toEqual({ pulse: 80, notes: "ab" });
      expect(rx.visit.investigations).toEqual([{ name: "CBC", instructions: "fasting" }]);
      const stored = JSON.stringify(rx.visit);
      expect(stored).not.toContain("�");
      expect(stored).not.toContain("\\ud800");
    });

    it("is removed from plain text columns instead of being stored as U+FFFD", async () => {
      const id = await start();
      expect((await saveDraft(doctor(), id, { advice: `x${LONE}y`, items: [{ drugName: `D${LONE}rug` }] })).ok).toBe(true);
      const rx = await read(id);
      expect(rx.visit.advice).toBe("xy");
      expect(rx.items[0].drugName).toBe("Drug");
    });

    it("keeps a valid emoji in jsonb text", async () => {
      const id = await start();
      expect((await saveDraft(doctor(), id, { vitals: { notes: `ok ${EMOJI}` } })).ok).toBe(true);
      expect((await read(id)).visit.vitals.notes).toBe(`ok ${EMOJI}`);
    });
  });

  describe("repeated phrases and the count limit", () => {
    it("treats case, extra spaces and Unicode composition as the same phrase", async () => {
      const id = await start();
      // "Viral  fever" has two spaces; the last entry is e + combining acute, the first is the precomposed form.
      await saveDraft(doctor(), id, {
        diagnosis: ["Viral fever", "viral  FEVER", " Viral\tfever ", "Café", "Café"],
        investigations: [{ name: "Dengue NS1" }, { name: "dengue   ns1" }],
      });
      const rx = await read(id);
      expect(rx.visit.diagnosis).toEqual(["Viral fever", "Café"]);
      expect(rx.visit.investigations).toEqual([{ name: "Dengue NS1" }]);
    });

    it("counts only distinct phrases against the limit", async () => {
      const id = await start();
      const thirtyUnique = Array.from({ length: 30 }, (_, i) => `Complaint ${i}`);
      expect((await saveDraft(doctor(), id, { complaints: [...thirtyUnique, "complaint 0"] })).ok).toBe(true);
      expect((await read(id)).visit.complaints).toEqual(thirtyUnique);
      expect(await saveDraft(doctor(), id, { complaints: [...thirtyUnique, "One more"] })).toMatchObject({
        ok: false,
        code: "invalid",
        field: "complaints",
      });

      const thirtyTests = Array.from({ length: 30 }, (_, i) => ({ name: `Test ${i}` }));
      expect((await saveDraft(doctor(), id, { investigations: [...thirtyTests, { name: "TEST 3" }] })).ok).toBe(true);
      expect(await saveDraft(doctor(), id, { investigations: [...thirtyTests, { name: "Test 30" }] })).toMatchObject({
        ok: false,
        code: "invalid",
        field: "investigations",
      });
    });
  });

  it("says 'at most N characters' because exactly N is allowed", async () => {
    const id = await start();
    expect((await saveDraft(doctor(), id, { advice: "x".repeat(2000) })).ok).toBe(true);
    expect(await saveDraft(doctor(), id, { advice: "x".repeat(2001) })).toMatchObject({
      ok: false,
      message: "Keep this to at most 2000 characters",
    });
  });

  it("ignores unknown vitals keys and treats a blank vitals form as no vitals", async () => {
    const id = await start();
    await saveDraft(doctor(), id, { vitals: { pulse: 80, evil: "<b>x</b>" } });
    expect((await read(id)).visit.vitals).toEqual({ pulse: 80 });
    await saveDraft(doctor(), id, { vitals: { pulse: "", notes: "  " } });
    expect((await read(id)).visit.vitals).toEqual({});
  });

  it.each([
    [{ advice: "x".repeat(2001) }, "advice"],
    [{ examinationNotes: "x".repeat(2001) }, "examinationNotes"],
    [{ complaints: Array.from({ length: 31 }, (_, i) => `C${i}`) }, "complaints"],
    [{ complaints: ["x".repeat(201)] }, "complaints"],
    [{ diagnosis: Array.from({ length: 21 }, (_, i) => `D${i}`) }, "diagnosis"],
    [{ vitals: { pulse: 720 } }, "vitals"],
    [{ vitals: { pulse: "abc" } }, "vitals"],
    [{ vitals: { pulse: 72.5 } }, "vitals"],
    [{ vitals: { bpSystolic: 120 } }, "vitals"],
    [{ vitals: { bpSystolic: 80, bpDiastolic: 120 } }, "vitals"],
    [{ vitals: { temperatureF: 37.5 } }, "vitals"],
    [{ investigations: [{ name: "" }] }, "investigations"],
    [{ investigations: Array.from({ length: 31 }, (_, i) => ({ name: `T${i}` })) }, "investigations"],
    [{ items: [{ drugName: "X", doseMorning: 0.3 }] }, "items"],
    [{ items: [{ drugName: "X", doseMorning: -1 }] }, "items"],
    [{ items: [{ drugName: "X", doseMorning: "one" }] }, "items"],
    [{ items: [{ drugName: "X", foodRelation: "sometimes" }] }, "items"],
    [{ items: [{ drugName: "X", periodicity: "hourly" }] }, "items"],
    [{ items: [{ drugName: "X", durationValue: 13, durationUnit: "months" }] }, "items"],
    [{ items: [{ drugName: "X", durationValue: 2.5 }] }, "items"],
    [{ items: [{ drugName: "X", durationValue: 1, durationUnit: "years" }] }, "items"],
    [{ items: [{ drugName: "X", isSos: "yes" }] }, "items"],
    [{ items: [{ drugName: "X", genericName: "g".repeat(301) }] }, "items"],
    [{ followUpReason: "y".repeat(301) }, "followUpReason"],
  ])("rejects %j", async (input, field) => {
    const id = await start();
    expect(await saveDraft(doctor(), id, input)).toMatchObject({ ok: false, code: "invalid", field });
  });

  it.each(["reception", "nurse", "pharmacist", "accountant"])("forbids %s from editing clinical fields", async (role) => {
    const id = await start();
    expect(await saveDraft(A.as(role), id, fullDraft())).toMatchObject({ ok: false, code: "forbidden" });
    expect((await read(id)).revision).toBe(0);
  });

  it("does not reveal another clinic's draft, and leaves it unchanged", async () => {
    const id = await start();
    expect((await saveDraft(doctor(), id, { advice: "Mine", items: [{ drugName: "Mine A" }] })).ok).toBe(true);
    expect(await saveDraft(B.as("doctor"), id, fullDraft(), { baseRevision: 1 })).toMatchObject({
      ok: false,
      code: "not_found",
    });
    const rx = await read(id);
    expect(rx.revision).toBe(1);
    expect(rx.visit.advice).toBe("Mine");
    expect(rx.items.map((i) => i.drugName)).toEqual(["Mine A"]);
  });
});

describe("draft revisions", () => {
  it("increments on every save and is returned by getPrescription", async () => {
    const id = await start();
    expect((await read(id)).revision).toBe(0);
    expect(await saveDraft(doctor(), id, { advice: "one" }, { baseRevision: 0 })).toMatchObject({ ok: true, value: { revision: 1 } });
    expect(await saveDraft(doctor(), id, { advice: "two" }, { baseRevision: 1 })).toMatchObject({ ok: true, value: { revision: 2 } });
    expect((await read(id)).revision).toBe(2);
  });

  it("rejects a stale base revision with the current revision and leaves the draft untouched", async () => {
    const id = await start();
    await saveDraft(doctor(), id, { advice: "Newer advice" }, { baseRevision: 0 });
    const stale = await saveDraft(
      doctor(),
      id,
      { advice: "Older advice", chiefComplaint: "Older complaint", items: [{ drugName: "Older drug" }] },
      { baseRevision: 0 },
    );
    expect(stale).toMatchObject({ ok: false, code: "conflict", currentRevision: 1 });
    const rx = await read(id);
    expect(rx.visit.advice).toBe("Newer advice");
    expect(rx.visit.chiefComplaint).toBeNull();
    expect(rx.items).toEqual([]);
    expect(rx.revision).toBe(1);
  });

  it("rejects a base revision newer than the stored one as a conflict", async () => {
    const id = await start();
    expect(await saveDraft(doctor(), id, { advice: "Future" }, { baseRevision: 5 })).toMatchObject({
      ok: false,
      code: "conflict",
      currentRevision: 0,
    });
    const rx = await read(id);
    expect(rx.visit.advice).toBeNull();
    expect(rx.revision).toBe(0);
  });

  it("never returns a mixed snapshot while saves are happening", async () => {
    const id = await start();
    const SAVES = 20;
    let done = false;
    const mismatches: string[] = [];
    const reader = (async () => {
      while (!done) {
        const rx = await read(id);
        const n = rx.revision;
        const advice = n === 0 ? null : `rev-${n}`;
        const names = n === 0 ? [] : Array.from({ length: (n % 3) + 1 }, (_, k) => `rev-${n}-${k}`);
        if (rx.visit.advice !== advice || rx.items.map((i) => i.drugName).join("|") !== names.join("|")) {
          mismatches.push(`revision ${n}: advice ${String(rx.visit.advice)}, items ${rx.items.map((i) => i.drugName).join("|")}`);
        }
      }
    })();
    try {
      for (let n = 1; n <= SAVES; n += 1) {
        const items = Array.from({ length: (n % 3) + 1 }, (_, k) => ({ drugName: `rev-${n}-${k}` }));
        const saved = await saveDraft(doctor(), id, { advice: `rev-${n}`, items }, { baseRevision: n - 1 });
        expect(saved).toMatchObject({ ok: true, value: { revision: n } });
      }
    } finally {
      done = true;
      await reader;
    }
    expect(mismatches).toEqual([]);
  });

  it("lets exactly one of two simultaneous saves from the same revision win, with no mixed content", async () => {
    const id = await start();
    const payloads = [
      { advice: "Window one", items: [{ drugName: "One A" }, { drugName: "One B" }] },
      { advice: "Window two", items: [{ drugName: "Two A" }] },
    ];
    const results = await Promise.all(payloads.map((p) => saveDraft(doctor(), id, p, { baseRevision: 0 })));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toMatchObject({ ok: false, code: "conflict", currentRevision: 1 });

    const winner = payloads[results.findIndex((r) => r.ok)];
    const rx = await read(id);
    expect(rx.visit.advice).toBe(winner.advice);
    expect(rx.items.map((i) => i.drugName)).toEqual(winner.items.map((i) => i.drugName));
  });

  it("still accepts saves without a base revision (Plan 1A callers: last write wins)", async () => {
    const id = await start();
    await saveDraft(doctor(), id, { advice: "a" }, { baseRevision: 0 });
    expect(await saveDraft(doctor(), id, { advice: "b" })).toMatchObject({ ok: true, value: { revision: 2 } });
  });

  it.each([-1, 1.5, Number.NaN])("rejects a malformed base revision %s", async (baseRevision) => {
    const id = await start();
    expect(await saveDraft(doctor(), id, { advice: "x" }, { baseRevision })).toMatchObject({
      ok: false,
      code: "invalid",
      field: "baseRevision",
    });
  });

  it("reports immutable, not conflict, once the prescription is finalized", async () => {
    const id = await start();
    await saveDraft(doctor(), id, { items: [{ drugName: "Paracetamol" }] }, { baseRevision: 0 });
    expect((await finalizePrescription(doctor(), id)).ok).toBe(true);
    expect(await saveDraft(doctor(), id, { advice: "late" }, { baseRevision: 1 })).toMatchObject({
      ok: false,
      code: "immutable",
    });
  });
});
