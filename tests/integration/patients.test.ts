import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { withTenant } from "@/server/db/tenant";
import { auditEvents, patients } from "@/server/db/schema";
import {
  archivePatient,
  createPatient,
  getPatient,
  searchPatients,
  updatePatient,
} from "@/server/services/patients";
import { clinicLocalDate } from "@/lib/domain/clinic-date";
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

  it("rejects a date of birth after today on the clinic's calendar but accepts today", async () => {
    // createTestTenant's clinic uses the default zone, Asia/Kolkata.
    const today = clinicLocalDate(new Date(), "Asia/Kolkata");
    const tomorrow = new Date(Date.parse(`${today}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    const future = await createPatient(A.as("owner"), { name: "Future Person", dob: tomorrow });
    expect(future).toMatchObject({ ok: false, code: "invalid", field: "dob" });
    expect(future.ok === false && future.message).toMatch(/future/i);

    expect((await createPatient(A.as("owner"), { name: "Newborn Person", dob: today })).ok).toBe(true);
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

describe("duplicate warnings", () => {
  it("lists the five newest matches, deterministically", async () => {
    const tenant = await createTestTenant("dupord");
    try {
      const made: string[] = [];
      for (let i = 0; i < 7; i++) {
        made.push((await create(tenant, `Shared Phone ${i}`, "9888811111")).id);
      }
      const warned = await createPatient(tenant.as("reception"), { name: "Latecomer", phone: "9888811111" });
      if (warned.ok || warned.code !== "duplicate_candidates") throw new Error("expected candidates");
      expect(warned.candidates.map((c) => c.id)).toEqual(made.slice(2).reverse());
    } finally {
      await tenant.cleanup();
    }
  });

  it("does not consume a patient number when it only warns", async () => {
    const tenant = await createTestTenant("dupseq");
    try {
      const first = await create(tenant, "Seq One", "9888822222");
      const warned = await createPatient(tenant.as("reception"), { name: "Seq Two", phone: "9888822222" });
      expect(warned).toMatchObject({ ok: false, code: "duplicate_candidates" });
      const second = await create(tenant, "Seq Two", "9888822222");
      expect(second.patientNo).toBe(first.patientNo + 1);
    } finally {
      await tenant.cleanup();
    }
  });
});

describe("input limits and hostile text", () => {
  it.each([
    ["name", { name: "n".repeat(121) }],
    ["phone", { name: "Valid Name", phone: "9".repeat(33) }],
    ["address", { name: "Valid Name", address: "a".repeat(301) }],
    ["notes", { name: "Valid Name", notes: "n".repeat(2001) }],
    ["allergies", { name: "Valid Name", allergies: Array.from({ length: 21 }, (_, i) => `Allergen ${i}`) }],
    ["allergies", { name: "Valid Name", allergies: ["x".repeat(81)] }],
  ])("rejects an over-long %s", async (field, input) => {
    expect(await createPatient(A.as("owner"), input)).toMatchObject({ ok: false, code: "invalid", field });
  });

  it("accepts values exactly at the limits", async () => {
    const result = await createPatient(A.as("owner"), {
      name: "n".repeat(120),
      address: "a".repeat(300),
      notes: "n".repeat(2000),
      allergies: Array.from({ length: 20 }, (_, i) => `Allergen ${i}`),
    });
    expect(result.ok).toBe(true);
  });

  it("the NUL escape used below really is one NUL character", () => {
    expect("a\u0000b".length).toBe(3);
    expect("a\u0000b".codePointAt(1)).toBe(0);
  });

  it.each([
    ["name", { name: "Bad\u0000Name" }],
    ["address", { name: "Valid Name", address: "x\u0000y" }],
    ["notes", { name: "Valid Name", notes: "x\u0000y" }],
    ["allergies", { name: "Valid Name", allergies: ["Pen\u0000icillin"] }],
    ["allergies", { name: "Valid Name", allergies: "Pen\u0000icillin, Sulfa" }],
  ])("returns invalid, not an error, for a NUL byte in %s", async (field, input) => {
    expect(await createPatient(A.as("owner"), input)).toMatchObject({ ok: false, code: "invalid", field });
  });

  it("returns invalid for a NUL byte on update too", async () => {
    const p = await create(A, "Nul Update Subject");
    expect(await updatePatient(A.as("owner"), p.id, { name: "Bad\u0000Name" })).toMatchObject({
      ok: false,
      code: "invalid",
      field: "name",
    });
  });
});

describe("updatePatient is a full replace", () => {
  const full = {
    name: "Full Record",
    phone: "9333344444",
    gender: "female",
    dob: "1990-05-17",
    address: "12 Test Road",
    allergies: ["Penicillin", "Sulfa"],
    notes: "Prefers mornings",
  };

  it("clears every optional field that the input omits", async () => {
    const p = await create(A, full.name, full.phone, {
      gender: full.gender,
      dob: full.dob,
      address: full.address,
      allergies: full.allergies,
      notes: full.notes,
    });
    const result = await updatePatient(A.as("owner"), p.id, { name: full.name });
    expect(result).toMatchObject({
      ok: true,
      value: { changedFields: ["phone", "gender", "dob", "address", "allergies", "notes"] },
    });
    const got = await getPatient(A.as("owner"), p.id);
    if (!got.ok) throw new Error(got.message);
    expect(got.value).toMatchObject({
      name: full.name,
      phone: null,
      phoneNormalized: null,
      gender: "unknown",
      dob: null,
      address: null,
      allergies: [],
      notes: null,
    });
  });

  it("reports dob and allergies changes, and ignores an unchanged allergy list", async () => {
    const p = await create(A, full.name, full.phone, { dob: full.dob, allergies: full.allergies });
    const same = await updatePatient(A.as("owner"), p.id, {
      name: full.name,
      phone: full.phone,
      dob: full.dob,
      allergies: "Penicillin, Sulfa",
    });
    expect(same).toMatchObject({ ok: true, value: { changedFields: [] } });

    const changed = await updatePatient(A.as("owner"), p.id, {
      name: full.name,
      phone: full.phone,
      dob: "1991-06-18",
      allergies: ["Penicillin"],
    });
    expect(changed).toMatchObject({ ok: true, value: { changedFields: ["dob", "allergies"] } });
  });

  it("returns not_found for an archived patient and invalid for bad input", async () => {
    const p = await create(A, "Soon Archived");
    expect(await updatePatient(A.as("owner"), p.id, { name: "A" })).toMatchObject({
      ok: false,
      code: "invalid",
      field: "name",
    });
    expect((await archivePatient(A.as("owner"), p.id)).ok).toBe(true);
    expect(await updatePatient(A.as("owner"), p.id, { name: "Revived Name" })).toMatchObject({
      ok: false,
      code: "not_found",
    });
  });

  it("audits archiving with the patient id and no personal data", async () => {
    const p = await create(A, "Audited Archive Person", "9444455555");
    expect((await archivePatient(A.as("owner"), p.id)).ok).toBe(true);
    const rows = await withTenant(A.tenantId, (tx) =>
      tx.select().from(auditEvents).where(eq(auditEvents.entityId, p.id)),
    );
    const archived = rows.filter((e) => e.action === "patient.archived");
    expect(archived).toHaveLength(1);
    expect(archived[0].entityType).toBe("patient");
    expect(JSON.stringify(archived[0])).not.toContain("Audited Archive Person");
    expect(JSON.stringify(archived[0])).not.toContain("9444455555");
  });
});

describe("search ordering, paging and hostile queries", () => {
  const BULK = 105;
  let tenant: TestTenant;
  let bulkIds: string[];

  beforeAll(async () => {
    tenant = await createTestTenant("bulk");
    // Identical names and identical created_at: only the id tiebreaker can order these. Inserted
    // in descending id order so physical order cannot accidentally match the expected order.
    bulkIds = Array.from({ length: BULK }, () => newId()).sort();
    const sameInstant = new Date("2026-01-01T00:00:00Z");
    await withTenant(tenant.tenantId, (tx) =>
      tx.insert(patients).values(
        [...bulkIds].reverse().map((id) => ({
          id,
          tenantId: tenant.tenantId,
          name: "Bulk Person",
          createdAt: sameInstant,
        })),
      ),
    );
  });
  afterAll(async () => tenant.cleanup());

  const page = async (opts: { q?: string; limit?: number; offset?: number }) => {
    const result = await searchPatients(tenant.as("reception"), opts);
    if (!result.ok) throw new Error(result.message);
    return result.value.map((p) => p.id);
  };

  const walk = async (q: string, size: number) => {
    const seen: string[] = [];
    for (let offset = 0; offset < BULK + size; offset += size) {
      seen.push(...(await page({ q, limit: size, offset })));
    }
    return seen;
  };

  it("pages a name search without gaps or repeats (name asc, id asc)", async () => {
    expect(await walk("Bulk", 7)).toEqual(bulkIds);
    expect(await walk("Bulk", 25)).toEqual(bulkIds);
  });

  it("pages an empty query without gaps or repeats (newest first, id desc)", async () => {
    const expected = [...bulkIds].reverse();
    expect(await walk("", 7)).toEqual(expected);
    expect(await walk("", 25)).toEqual(expected);
  });

  it("clamps limit to 100 rows", async () => {
    expect(await page({ q: "", limit: 100000 })).toHaveLength(100);
    expect(await page({ q: "", limit: Infinity })).toHaveLength(100);
    expect(await page({ q: "", limit: 100 })).toHaveLength(100);
    expect(await page({ q: "", limit: -5 })).toHaveLength(1);
  });

  it("clamps offset into a safe range instead of failing", async () => {
    const first = await page({ q: "", limit: 3 });
    expect(await page({ q: "", limit: 3, offset: -10 })).toEqual(first);
    expect(await page({ q: "", limit: 3, offset: Number.NaN })).toEqual(first);
    expect(await page({ q: "", limit: 3, offset: -Infinity })).toEqual(first);
    expect(await page({ q: "", limit: 3, offset: Infinity })).toEqual([]);
    expect(await page({ q: "", limit: 3, offset: 1e21 })).toEqual([]);
    expect(await page({ q: "", limit: 3, offset: 2.9 })).toEqual(await page({ q: "", limit: 3, offset: 2 }));
  });

  it("returns newest first for an empty query", async () => {
    const ordered = await createTestTenant("newest");
    try {
      await create(ordered, "First Made");
      await create(ordered, "Second Made");
      await create(ordered, "Third Made");
      const result = await searchPatients(ordered.as("reception"), { q: "" });
      expect(result.ok && result.value.map((p) => p.name)).toEqual(["Third Made", "Second Made", "First Made"]);
    } finally {
      await ordered.cleanup();
    }
  });

  it("returns an empty list, not an error, for a query containing a NUL byte", async () => {
    expect(await searchPatients(tenant.as("reception"), { q: "Bulk\u0000" })).toEqual({ ok: true, value: [] });
    expect(await searchPatients(tenant.as("reception"), { q: "\u0000" })).toEqual({ ok: true, value: [] });
  });

  it("truncates a query to 100 characters instead of failing", async () => {
    const needle = "z".repeat(110);
    await create(A, needle);
    const huge = await searchPatients(A.as("reception"), { q: "x".repeat(10_000) });
    expect(huge).toEqual({ ok: true, value: [] });
    const truncated = await searchPatients(A.as("reception"), { q: `${"z".repeat(100)}QQQ` });
    expect(truncated.ok && truncated.value.map((p) => p.name)).toEqual([needle]);
  });
});
