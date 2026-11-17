import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { adminDb } from "@/server/db/admin";
import { prescriptions, visits } from "@/server/db/schema";
import { createPatient } from "@/server/services/patients";
import { amendPrescription, getPrescription, startPrescription } from "@/server/services/prescriptions";
import { finalizeNow, saveDraftNow } from "../helpers/rx";
import { createTestTenant, type TestTenant } from "../helpers/tenant";

// The validation layer is replaced with a pass-through so that inputs it would normally refuse reach
// Postgres. This proves the service's second line of defence: database input errors become `invalid`
// results instead of thrown errors. (The validation layer itself is tested in the other files.)
vi.mock("@/server/validation/prescription", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/validation/prescription")>();
  const { z } = await import("zod");
  return {
    ...original,
    draftInputSchema: z.custom<ReturnType<typeof original.draftInputSchema.parse>>(),
    amendReasonSchema: z.string(),
  };
});

const NUL = "\u0000";

let A: TestTenant;
let patientId = "";

beforeAll(async () => {
  A = await createTestTenant("rxdberr");
  const p = await createPatient(A.as("reception"), { name: "Db Error Patient" });
  if (!p.ok) throw new Error(p.message);
  patientId = p.value.id;
});
afterAll(async () => {
  await A.cleanup();
});

const doctor = () => A.as("doctor");

const goodDraft = {
  visitType: "new",
  chiefComplaint: "Fever",
  diagnosis: ["Viral fever"],
  advice: "Rest",
  followUpDate: "2026-12-01",
  items: [{ drugName: "Paracetamol" }],
};

async function startDraft(): Promise<string> {
  const started = await startPrescription(doctor(), { patientId });
  if (!started.ok) throw new Error(started.message);
  return started.value.prescriptionId;
}

describe("saveDraft database input errors", () => {
  it("is a single NUL code point", () => {
    expect([...NUL]).toHaveLength(1);
  });

  it("maps invalid byte sequence (22021) to invalid and keeps the previous draft", async () => {
    const id = await startDraft();
    expect((await saveDraftNow(doctor(), id, goodDraft)).ok).toBe(true);

    const result = await saveDraftNow(doctor(), id, { ...goodDraft, advice: `bad${NUL}advice`, items: [{ drugName: "Changed" }] });
    expect(result).toMatchObject({ ok: false, code: "invalid" });

    const got = await getPrescription(doctor(), id);
    expect(got.ok && got.value.visit.advice).toBe("Rest");
    expect(got.ok && got.value.items.map((i) => i.drugName)).toEqual(["Paracetamol"]);
  });

  it("maps a NUL inside a text[] column (diagnosis) the same way", async () => {
    const id = await startDraft();
    expect(await saveDraftNow(doctor(), id, { ...goodDraft, diagnosis: [`bad${NUL}`] })).toMatchObject({
      ok: false,
      code: "invalid",
    });
  });

  it.each([
    ["vitals notes", { vitals: { notes: "a\ud800b" } }],
    ["a test name", { investigations: [{ name: "C\udc00BC" }] }],
  ])("maps a lone surrogate Postgres jsonb rejects (%s) to invalid and keeps the previous draft", async (_name, extra) => {
    expect("\ud800").toHaveLength(1);
    const id = await startDraft();
    expect((await saveDraftNow(doctor(), id, goodDraft)).ok).toBe(true);

    expect(await saveDraftNow(doctor(), id, { ...goodDraft, advice: "Changed", ...extra })).toMatchObject({
      ok: false,
      code: "invalid",
    });
    const got = await getPrescription(doctor(), id);
    expect(got.ok && got.value.visit.advice).toBe("Rest");
  });

  it.each(["0000-01-01", "2026-02-30"])("maps a date Postgres rejects (%s) to invalid on followUpDate", async (date) => {
    const id = await startDraft();
    expect((await saveDraftNow(doctor(), id, goodDraft)).ok).toBe(true);

    expect(await saveDraftNow(doctor(), id, { ...goodDraft, followUpDate: date })).toMatchObject({
      ok: false,
      code: "invalid",
      field: "followUpDate",
    });
    const got = await getPrescription(doctor(), id);
    expect(got.ok && got.value.visit.followUpDate).toBe("2026-12-01");
  });

  it("still maps the immutability error (23000) to immutable and rethrows unknown errors", async () => {
    const id = await startDraft();
    const [rx] = await adminDb.select({ visitId: prescriptions.visitId }).from(prescriptions).where(eq(prescriptions.id, id));
    await adminDb.update(visits).set({ status: "finalized", finalizedAt: new Date() }).where(eq(visits.id, rx.visitId));
    expect(await saveDraftNow(doctor(), id, goodDraft)).toMatchObject({ ok: false, code: "immutable" });

    // An unmapped database error (integer overflow, 22003) must still surface as a thrown error,
    // never as a quiet failure result.
    const id2 = await startDraft();
    await expect(
      saveDraftNow(doctor(), id2, { ...goodDraft, items: [{ drugName: "X", durationDays: 2 ** 40 }] }),
    ).rejects.toBeDefined();
  });
});

describe("amendPrescription database input errors", () => {
  it("maps a NUL in the reason (22021) to invalid on reason and creates no amendment", async () => {
    const id = await startDraft();
    expect((await saveDraftNow(doctor(), id, goodDraft)).ok).toBe(true);
    expect((await finalizeNow(doctor(), id)).ok).toBe(true);

    const before = await adminDb.select({ id: prescriptions.id }).from(prescriptions).where(eq(prescriptions.tenantId, A.tenantId));
    const result = await amendPrescription(doctor(), { prescriptionId: id, reason: `Wrong${NUL} dose` });
    expect(result).toMatchObject({ ok: false, code: "invalid", field: "reason" });
    const after = await adminDb.select({ id: prescriptions.id }).from(prescriptions).where(eq(prescriptions.tenantId, A.tenantId));
    expect(after).toHaveLength(before.length);
    expect(await getPrescription(doctor(), id)).toMatchObject({ ok: true, value: { status: "finalized" } });
  });
});
