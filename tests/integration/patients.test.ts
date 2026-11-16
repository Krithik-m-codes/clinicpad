import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { withTenant } from "@/server/db/tenant";
import { auditEvents } from "@/server/db/schema";
import {
  archivePatient,
  createPatient,
  getPatient,
  searchPatients,
  updatePatient,
} from "@/server/services/patients";
import { newId } from "@/lib/domain/ids";
import { createTestTenant, type TestTenant } from "../helpers/tenant";

let A: TestTenant;
let B: TestTenant;

beforeAll(async () => {
  A = await createTestTenant("pta");
  B = await createTestTenant("ptb");
});
afterAll(async () => {
  await A.cleanup();
  await B.cleanup();
});

async function create(t: TestTenant, name: string, phone?: string, extra: Record<string, unknown> = {}) {
  const result = await createPatient(t.as("reception"), { name, phone, ...extra }, { allowDuplicate: true });
  if (!result.ok) throw new Error(`setup failed: ${result.message}`);
  return result.value;
}

/** Calendar date in UTC, offset by whole days from today. */
function utcDate(offsetDays: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

describe("createPatient", () => {
  it("numbers patients sequentially per tenant", async () => {
    const a1 = await create(A, "Numbering One");
    const a2 = await create(A, "Numbering Two");
    const b1 = await create(B, "Numbering Other Clinic");
    expect(a2.patientNo).toBe(a1.patientNo + 1);
    expect(b1.patientNo).toBe(1);
  });

  it("lets reception register patients but not accountants", async () => {
    expect((await createPatient(A.as("reception"), { name: "Allowed Person" })).ok).toBe(true);
    const denied = await createPatient(A.as("accountant"), { name: "Denied Person" });
    expect(denied).toMatchObject({ ok: false, code: "forbidden" });
  });

  it.each([
    [{ name: "A" }, "name"],
    [{ name: "Valid Name", phone: "12" }, "phone"],
    [{ name: "Valid Name", dob: "2999-01-01" }, "dob"],
    [{ name: "Valid Name", dob: "2026-02-31" }, "dob"],
    [{ name: "Valid Name", gender: "robot" }, "gender"],
  ])("rejects invalid input %j", async (input, field) => {
    const result = await createPatient(A.as("owner"), input);
    expect(result).toMatchObject({ ok: false, code: "invalid", field });
  });

  it("rejects a date of birth before 1900-01-01 and accepts the boundary", async () => {
    const tooOld = await createPatient(A.as("owner"), { name: "Too Old Person", dob: "1899-12-31" });
    expect(tooOld).toMatchObject({ ok: false, code: "invalid", field: "dob" });
    expect(tooOld.ok === false && tooOld.message).toMatch(/1900/);

    expect((await createPatient(A.as("owner"), { name: "Boundary Person", dob: "1900-01-01" })).ok).toBe(true);
  });

  it("rejects a date of birth after today but accepts today (UTC)", async () => {
    const future = await createPatient(A.as("owner"), { name: "Future Person", dob: utcDate(1) });
    expect(future).toMatchObject({ ok: false, code: "invalid", field: "dob" });
    expect(future.ok === false && future.message).toMatch(/future/i);

    expect((await createPatient(A.as("owner"), { name: "Newborn Person", dob: utcDate(0) })).ok).toBe(true);
  });

  it("accepts a real leap day and rejects a non-existent one", async () => {
    expect((await createPatient(A.as("owner"), { name: "Leap Person", dob: "2024-02-29" })).ok).toBe(true);
    const result = await createPatient(A.as("owner"), { name: "Not Leap Person", dob: "2025-02-29" });
    expect(result).toMatchObject({ ok: false, code: "invalid", field: "dob" });
  });

  it("treats blank optional form fields as absent", async () => {
    const result = await createPatient(A.as("owner"), {
      name: "Blank Fields",
      phone: "",
      dob: "",
      address: "",
      notes: "",
      allergies: "",
    });
    expect(result.ok).toBe(true);
  });

  it("parses comma-separated allergies", async () => {
    const created = await create(A, "Allergic Person", undefined, { allergies: "Penicillin, Sulfa ,," });
    const got = await getPatient(A.as("owner"), created.id);
    expect(got.ok && got.value.allergies).toEqual(["Penicillin", "Sulfa"]);
  });

  it("warns about duplicates by phone across number formats, then allows confirming", async () => {
    await create(A, "Original Dup", "+91 98765 43210");

    const warned = await createPatient(A.as("reception"), { name: "Other Name", phone: "9876543210" });
    expect(warned).toMatchObject({ ok: false, code: "duplicate_candidates" });
    if (warned.ok || warned.code !== "duplicate_candidates") throw new Error("expected candidates");
    expect(warned.candidates[0]).toMatchObject({ name: "Original Dup", sameName: false });

    const sameNameWarned = await createPatient(A.as("reception"), { name: "original dup", phone: "09876543210" });
    if (sameNameWarned.ok || sameNameWarned.code !== "duplicate_candidates") throw new Error("expected candidates");
    expect(sameNameWarned.candidates[0].sameName).toBe(true);

    const confirmed = await createPatient(
      A.as("reception"),
      { name: "Family Member", phone: "9876543210" },
      { allowDuplicate: true },
    );
    expect(confirmed.ok).toBe(true);
  });

  it("does not report another clinic's patients as duplicates", async () => {
    await create(A, "Cross Clinic", "9000000001");
    const result = await createPatient(B.as("reception"), { name: "Cross Clinic", phone: "9000000001" });
    expect(result.ok).toBe(true);
  });

  it("audits creation with ids only, not the patient's name or phone", async () => {
    const created = await create(A, "Private Name Person", "9111111111");
    const rows = await withTenant(A.tenantId, (tx) =>
      tx.select().from(auditEvents).where(eq(auditEvents.entityId, created.id)),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe("patient.created");
    expect(JSON.stringify(rows[0])).not.toContain("Private Name Person");
    expect(JSON.stringify(rows[0])).not.toContain("9111111111");
  });
});

describe("searchPatients", () => {
  let tenant: TestTenant;
  let ids: Record<string, string>;

  beforeAll(async () => {
    tenant = await createTestTenant("srch");
    const seed = async (name: string, phone?: string) => (await create(tenant, name, phone)).id;
    ids = {
      asha: await seed("Asha Rao", "+91 98765 43210"),
      ravi: await seed("Ravi Sharma", "9822012345"),
      percent: await seed("100% Sure Kumar", "9000012345"),
      hindi: await seed("आशा राव", "9333312345"),
      gone: await seed("Archived Asha", "9444412345"),
    };
    await archivePatient(tenant.as("owner"), ids.gone);
  });
  afterAll(async () => tenant.cleanup());

  const names = async (q?: string, limit?: number) => {
    const result = await searchPatients(tenant.as("reception"), { q, limit });
    if (!result.ok) throw new Error(result.message);
    return result.value.map((p) => p.name);
  };

  it("matches names case-insensitively and by substring", async () => {
    expect(await names("asha")).toEqual(["Asha Rao"]);
    expect(await names("SHARMA")).toEqual(["Ravi Sharma"]);
  });

  it("matches phone numbers typed in any format, and partial digits", async () => {
    expect(await names("+91 98765 43210")).toEqual(["Asha Rao"]);
    expect(await names("98765")).toEqual(["Asha Rao"]);
    expect(await names("9822012345")).toEqual(["Ravi Sharma"]);
  });

  it("matches a patient number", async () => {
    const first = await searchPatients(tenant.as("reception"), { q: "" });
    if (!first.ok) throw new Error(first.message);
    const target = first.value.find((p) => p.name === "Ravi Sharma");
    expect(target?.patientNo).toBeTruthy();
    expect(await names(String(target?.patientNo))).toContain("Ravi Sharma");
  });

  it("treats LIKE wildcards literally", async () => {
    expect(await names("%")).toEqual(["100% Sure Kumar"]);
    expect(await names("_")).toEqual([]);
    expect(await names("\\")).toEqual([]);
  });

  it("finds Devanagari names", async () => {
    expect(await names("आशा")).toEqual(["आशा राव"]);
  });

  it("excludes archived patients", async () => {
    expect(await names("Archived")).toEqual([]);
  });

  it("returns recent patients for an empty query and respects limit", async () => {
    expect((await names("")).length).toBe(4);
    expect(await names("", 2)).toHaveLength(2);
    expect(await names("   ")).toHaveLength(4);
  });

  it("clamps absurd limits instead of failing", async () => {
    expect((await names("", 100000)).length).toBe(4);
    expect((await names("", -5)).length).toBeGreaterThan(0);
  });

  it("never returns another clinic's patients", async () => {
    const result = await searchPatients(B.as("owner"), { q: "Asha" });
    expect(result.ok && result.value.some((p) => p.name === "Asha Rao")).toBe(false);
  });

  it("denies roles without patient access", async () => {
    expect(await searchPatients(tenant.as("accountant"), { q: "" })).toMatchObject({ ok: false, code: "forbidden" });
  });
});

describe("getPatient / updatePatient / archivePatient", () => {
  it("returns not_found for another clinic's id, unknown ids, and malformed ids", async () => {
    const mine = await create(A, "Isolation Subject");
    expect(await getPatient(B.as("owner"), mine.id)).toMatchObject({ ok: false, code: "not_found" });
    expect(await getPatient(A.as("owner"), newId())).toMatchObject({ ok: false, code: "not_found" });
    expect(await getPatient(A.as("owner"), "not-a-uuid")).toMatchObject({ ok: false, code: "not_found" });
    expect(await updatePatient(B.as("owner"), mine.id, { name: "Hijacked" })).toMatchObject({
      ok: false,
      code: "not_found",
    });
    expect(await updatePatient(A.as("owner"), "not-a-uuid", { name: "Valid Name" })).toMatchObject({
      ok: false,
      code: "not_found",
    });
    expect(await archivePatient(B.as("owner"), mine.id)).toMatchObject({ ok: false, code: "not_found" });
    expect(await archivePatient(A.as("owner"), "not-a-uuid")).toMatchObject({ ok: false, code: "not_found" });
  });

  it("updates fields, reports which changed, and audits field names only", async () => {
    const p = await create(A, "Before Update", "9555555555");
    const result = await updatePatient(A.as("doctor"), p.id, {
      name: "After Update",
      phone: "9555555555",
      gender: "female",
    });
    expect(result).toMatchObject({ ok: true, value: { changedFields: ["name", "gender"] } });

    const got = await getPatient(A.as("doctor"), p.id);
    expect(got.ok && got.value.name).toBe("After Update");

    const audit = await withTenant(A.tenantId, (tx) =>
      tx.select().from(auditEvents).where(eq(auditEvents.entityId, p.id)),
    );
    const updated = audit.find((e) => e.action === "patient.updated");
    expect(updated?.after).toEqual({ changedFields: ["name", "gender"] });
    expect(JSON.stringify(updated)).not.toContain("After Update");
  });

  it("is a no-op, with no audit event, when nothing changed", async () => {
    const p = await create(A, "No Change", "9666666666");
    const result = await updatePatient(A.as("owner"), p.id, { name: "No Change", phone: "9666666666" });
    expect(result).toMatchObject({ ok: true, value: { changedFields: [] } });
    const audit = await withTenant(A.tenantId, (tx) =>
      tx.select().from(auditEvents).where(eq(auditEvents.entityId, p.id)),
    );
    expect(audit.filter((e) => e.action === "patient.updated")).toHaveLength(0);
  });

  it("lets only owners archive, and archived patients disappear", async () => {
    const p = await create(A, "To Archive");
    expect(await archivePatient(A.as("doctor"), p.id)).toMatchObject({ ok: false, code: "forbidden" });
    expect((await archivePatient(A.as("owner"), p.id)).ok).toBe(true);
    expect(await getPatient(A.as("owner"), p.id)).toMatchObject({ ok: false, code: "not_found" });
    expect(await archivePatient(A.as("owner"), p.id)).toMatchObject({ ok: false, code: "not_found" });
  });

  it("lets nurses read patients but not create, update or archive them", async () => {
    const p = await create(A, "Nurse Visible", "9777777777");
    const nurse = A.as("nurse");

    const found = await searchPatients(nurse, { q: "Nurse Visible" });
    expect(found.ok && found.value.map((x) => x.name)).toEqual(["Nurse Visible"]);
    expect((await getPatient(nurse, p.id)).ok).toBe(true);

    expect(await createPatient(nurse, { name: "Nurse Created" })).toMatchObject({ ok: false, code: "forbidden" });
    expect(await updatePatient(nurse, p.id, { name: "Nurse Edited" })).toMatchObject({
      ok: false,
      code: "forbidden",
    });
    expect(await archivePatient(nurse, p.id)).toMatchObject({ ok: false, code: "forbidden" });

    const after = await getPatient(A.as("owner"), p.id);
    expect(after.ok && after.value.name).toBe("Nurse Visible");
  });
});
