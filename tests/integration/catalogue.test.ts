import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray, like, or, sql } from "drizzle-orm";
import { adminDb } from "@/server/db/admin";
import { withTenant } from "@/server/db/tenant";
import { auditEvents, doctors, globalClinicalTerms, globalMedicines, medicineFavourites, users } from "@/server/db/schema";
import {
  addClinicMedicine,
  compareMedicineHits,
  listFavourites,
  removeFavourite,
  saveFavourite,
  searchMedicines,
  suggestTerms,
} from "@/server/services/catalogue";
import { newId } from "@/lib/domain/ids";
import type { ServiceContext } from "@/server/services/context";
import { createTestTenant, type TestTenant } from "../helpers/tenant";

const stamp = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const P = `ZQ${stamp}`;
const key = P.toLowerCase();
const prefixKey = `paramol ${stamp.toLowerCase()}`;

let A: TestTenant;
let B: TestTenant;
let secondDoctor: ServiceContext;
const extraUsers: string[] = [];

/** Another prescriber in the same clinic, with a doctor profile of their own. */
async function extraDoctor(tenantId: string, label: string): Promise<{ ctx: ServiceContext; doctorId: string }> {
  const [user] = await adminDb
    .insert(users)
    .values({ email: `${label}-${stamp}@example.com`, name: "Dr Extra", passwordHash: "not-a-real-hash" })
    .returning();
  extraUsers.push(user.id);
  const [doctor] = await adminDb.insert(doctors).values({ tenantId, userId: user.id }).returning();
  return { ctx: { tenantId, userId: user.id, role: "doctor" }, doctorId: doctor.id };
}

beforeAll(async () => {
  A = await createTestTenant("cata");
  B = await createTestTenant("catb");
  secondDoctor = (await extraDoctor(A.tenantId, "cat-second")).ctx;
  await adminDb.insert(globalMedicines).values([
    { name: `${P} PARAMOL 500 TAB`, genericName: `${P} Paracetamol 500mg`, nameKey: `${key} paramol 500 tab` },
    { name: `${P} 100% PURE SYRUP`, genericName: null, nameKey: `${key} 100% pure syrup` },
    { name: `${P} 1000 MG TAB`, genericName: null, nameKey: `${key} 1000 mg tab` },
    { name: `${P} AB_C TAB`, genericName: null, nameKey: `${key} ab_c tab` },
    { name: `${P} ABXC TAB`, genericName: null, nameKey: `${key} abxc tab` },
    { name: `PARAMOL ${stamp} GLOBAL SYRUP`, genericName: null, nameKey: `${prefixKey} global syrup` },
  ]);
  await adminDb.insert(globalClinicalTerms).values([
    { kind: "complaint", name: `${P} FEVER WITH CHILLS`, nameKey: `${key} fever with chills` },
    { kind: "test", name: `${P} CBC`, nameKey: `${key} cbc` },
  ]);
});

afterAll(async () => {
  // Independent steps: a failure in one must never skip the others.
  try {
    try {
      await adminDb.delete(globalMedicines).where(or(like(globalMedicines.nameKey, `${key}%`), like(globalMedicines.nameKey, `${prefixKey}%`)));
      await adminDb.delete(globalClinicalTerms).where(like(globalClinicalTerms.nameKey, `${key}%`));
    } finally {
      try {
        await A.cleanup();
      } finally {
        await B.cleanup();
      }
    }
  } finally {
    if (extraUsers.length > 0) await adminDb.delete(users).where(inArray(users.id, extraUsers));
  }
});

/** Names from a search, limited to rows this test file created. */
async function names(ctx: ServiceContext, q: unknown): Promise<string[]> {
  const result = await searchMedicines(ctx, { q });
  if (!result.ok) throw new Error(result.message);
  return result.value.map((h) => h.name).filter((n) => n.includes(stamp));
}

describe("searchMedicines", () => {
  it("finds global medicines by name and by generic name", async () => {
    expect(await names(A.as("doctor"), `${P} PARA`)).toEqual([`${P} PARAMOL 500 TAB`]);
    expect(await names(A.as("doctor"), `${P} paracetamol 500MG`)).toEqual([`${P} PARAMOL 500 TAB`]);
  });

  it("treats % and _ literally", async () => {
    expect(await names(A.as("doctor"), `${P} 100%`)).toEqual([`${P} 100% PURE SYRUP`]);
    expect(await names(A.as("doctor"), `${P} AB_C`)).toEqual([`${P} AB_C TAB`]);
  });

  it("ranks prefix matches before substring matches, whatever their source", async () => {
    // The substring match is a clinic medicine and the prefix match a global one, so source order alone would get this wrong.
    const added = await addClinicMedicine(A.as("doctor"), { name: `${P} PARAMOL ${stamp} DROPS` });
    expect(added.ok).toBe(true);
    const found = await names(A.as("doctor"), `PARAMOL ${stamp}`);
    expect(found).toEqual([`PARAMOL ${stamp} GLOBAL SYRUP`, `${P} PARAMOL ${stamp} DROPS`]);
  });

  it("orders hits totally: favourite, prefix, source, name, then id", () => {
    const hit = (source: "favourite" | "clinic" | "global", name: string, id: string) => ({
      source,
      id,
      name,
      genericName: null,
      favourite: null,
    });
    const tied = [hit("global", "Same", "b"), hit("global", "Same", "c"), hit("global", "Same", "a")];
    expect([...tied].sort((x, y) => compareMedicineHits(x, y, "sa")).map((h) => h.id)).toEqual(["a", "b", "c"]);
    expect([...tied].reverse().sort((x, y) => compareMedicineHits(x, y, "sa")).map((h) => h.id)).toEqual(["a", "b", "c"]);
    expect(compareMedicineHits(tied[0], tied[0], "sa")).toBe(0);
    // Earlier keys still win over the id.
    expect(compareMedicineHits(hit("clinic", "Same", "z"), hit("global", "Same", "a"), "sa")).toBeLessThan(0);
    expect(compareMedicineHits(hit("global", "Same", "z"), hit("global", "Sameb", "a"), "sa")).toBeLessThan(0);
  });

  it("keeps clinic medicines inside their clinic and audits ids only", async () => {
    const name = `${P} CLINIC ONLY SYRUP`;
    const first = await addClinicMedicine(A.as("doctor"), { name, genericName: "House blend" });
    const again = await addClinicMedicine(A.as("owner"), { name: `  ${name.toLowerCase()}  ` });
    if (!first.ok || !again.ok) throw new Error("setup failed");
    expect(first.value.created).toBe(true);
    expect(again.value).toEqual({ id: first.value.id, created: false });

    expect(await names(A.as("doctor"), `${P} CLINIC ONLY`)).toEqual([name]);
    expect(await names(B.as("doctor"), `${P} CLINIC ONLY`)).toEqual([]);

    const audit = await withTenant(A.tenantId, (tx) =>
      tx.select().from(auditEvents).where(eq(auditEvents.entityId, first.value.id)),
    );
    expect(audit.map((e) => e.action)).toEqual(["medicine.added"]);
    expect(JSON.stringify(audit)).not.toContain("CLINIC ONLY");
  });

  it("finds Devanagari clinic medicines", async () => {
    await addClinicMedicine(A.as("doctor"), { name: `क्रोसिन ${stamp}` });
    expect(await names(A.as("doctor"), `क्रोसिन ${stamp}`)).toEqual([`क्रोसिन ${stamp}`]);
  });

  it("survives hostile search input without errors", async () => {
    for (const q of ["x".repeat(10_000), "\u0000%", "'; drop table patients; --", 123, null, { q: "x" }]) {
      const result = await searchMedicines(A.as("doctor"), { q });
      expect(result.ok).toBe(true);
    }
    const capped = await searchMedicines(A.as("doctor"), { q: "TAB", limit: 100_000 });
    expect(capped.ok && capped.value.length).toBeLessThanOrEqual(50);
  });

  it("enforces roles", async () => {
    expect(await searchMedicines(A.as("reception"), { q: "x" })).toMatchObject({ ok: false, code: "forbidden" });
    expect(await searchMedicines(A.as("accountant"), { q: "x" })).toMatchObject({ ok: false, code: "forbidden" });
    expect((await searchMedicines(A.as("nurse"), { q: "x" })).ok).toBe(true);
    expect((await searchMedicines(A.as("pharmacist"), { q: "x" })).ok).toBe(true);
    for (const role of ["nurse", "pharmacist", "accountant", "reception"]) {
      expect(await addClinicMedicine(A.as(role), { name: `Role ${role} Med` })).toMatchObject({ ok: false, code: "forbidden" });
    }
    expect((await addClinicMedicine(A.as("owner"), { name: `${P} OWNER MED` })).ok).toBe(true);
  });

  it("never throws on missing or hostile options", async () => {
    // Deliberately outside the declared types: server actions pass whatever the client sent.
    const search = searchMedicines as (ctx: ServiceContext, opts?: unknown) => ReturnType<typeof searchMedicines>;
    for (const opts of [null, undefined, "x", 5, []]) {
      expect((await search(A.as("doctor"), opts)).ok).toBe(true);
    }
  });

  it("validates clinic medicine names, refusing a NUL rather than stripping it", async () => {
    const NUL = "\u0000";
    expect([...NUL]).toHaveLength(1);
    expect(await addClinicMedicine(A.as("doctor"), { name: " " })).toMatchObject({ ok: false, code: "invalid", field: "name" });
    expect(await addClinicMedicine(A.as("doctor"), { name: "x".repeat(201) })).toMatchObject({
      ok: false,
      code: "invalid",
      field: "name",
    });
    expect(await addClinicMedicine(A.as("doctor"), { name: `Bad${NUL}Syrup` })).toMatchObject({
      ok: false,
      code: "invalid",
      field: "name",
    });
    expect(await addClinicMedicine(A.as("doctor"), { name: "Good Syrup", genericName: `Bad${NUL}Generic` })).toMatchObject({
      ok: false,
      code: "invalid",
      field: "genericName",
    });
  });
});

describe("favourites", () => {
  const line = {
    drugName: `${P} PARAMOL 500 TAB`,
    genericName: "Paracetamol 500mg",
    doseMorning: 1,
    doseAfternoon: 0,
    doseNight: 1,
    foodRelation: "after",
    durationValue: 5,
    durationUnit: "days",
  };

  it("saves a prescriber's default line and offers it first in search", async () => {
    const saved = await saveFavourite(A.as("doctor"), line);
    expect(saved).toMatchObject({ ok: true, value: { drugName: line.drugName, doseNight: 1, durationValue: 5 } });

    const result = await searchMedicines(A.as("doctor"), { q: P });
    if (!result.ok) throw new Error(result.message);
    expect(result.value[0]).toMatchObject({ source: "favourite", name: line.drugName, favourite: { foodRelation: "after" } });

    const empty = await searchMedicines(A.as("doctor"), { q: "" });
    expect(empty.ok && empty.value.map((h) => h.name)).toContain(line.drugName);
  });

  it("keeps one favourite per medicine name and updates it", async () => {
    const first = await saveFavourite(A.as("doctor"), line);
    const second = await saveFavourite(A.as("doctor"), { ...line, drugName: `  ${line.drugName.toLowerCase()} `, durationValue: 3 });
    if (!first.ok || !second.ok) throw new Error("setup failed");
    expect(second.value.id).toBe(first.value.id);
    expect(second.value.durationValue).toBe(3);
    const list = await listFavourites(A.as("doctor"));
    expect(list.ok && list.value.filter((f) => f.drugName.includes(stamp))).toHaveLength(1);
  });

  it("keeps favourites private to each prescriber and clinic", async () => {
    const mine = await saveFavourite(A.as("doctor"), line);
    if (!mine.ok) throw new Error(mine.message);
    expect(await listFavourites(secondDoctor)).toEqual({ ok: true, value: [] });
    expect(await listFavourites(B.as("doctor"))).toEqual({ ok: true, value: [] });
    expect(await removeFavourite(secondDoctor, mine.value.id)).toMatchObject({ ok: false, code: "not_found" });
    expect(await removeFavourite(B.as("doctor"), mine.value.id)).toMatchObject({ ok: false, code: "not_found" });
  });

  it("validates favourite lines like prescription items", async () => {
    expect(await saveFavourite(A.as("doctor"), { drugName: "" })).toMatchObject({ ok: false, code: "invalid", field: "drugName" });
    expect(await saveFavourite(A.as("doctor"), { drugName: "X", doseMorning: 0.3 })).toMatchObject({
      ok: false,
      code: "invalid",
      field: "doseMorning",
    });
  });

  it("belong to a doctor profile: a prescriber without one has none and cannot save one", async () => {
    const profileless: ServiceContext = { tenantId: A.tenantId, userId: newId(), role: "owner" };
    expect(await listFavourites(profileless)).toEqual({ ok: true, value: [] });
    expect(await saveFavourite(profileless, line)).toMatchObject({ ok: false, code: "invalid", field: "favourites" });
    const search = await searchMedicines(profileless, { q: "" });
    expect(search).toEqual({ ok: true, value: [] });
  });

  it("caps favourites per prescriber but still updates existing ones", async () => {
    const { ctx: third, doctorId } = await extraDoctor(A.tenantId, "cat-third");
    await adminDb.insert(medicineFavourites).values(
      Array.from({ length: 200 }, (_, i) => ({
        tenantId: A.tenantId,
        doctorId,
        nameKey: `cap ${i}`,
        drugName: `Cap ${i}`,
      })),
    );
    expect(await saveFavourite(third, { drugName: "One Too Many" })).toMatchObject({
      ok: false,
      code: "invalid",
      field: "favourites",
    });
    expect(await saveFavourite(third, { drugName: "Cap 7", doseNight: 1 })).toMatchObject({ ok: true });
  });

  it("removes a favourite", async () => {
    const saved = await saveFavourite(secondDoctor, { drugName: `${P} REMOVE ME` });
    if (!saved.ok) throw new Error(saved.message);
    expect(await removeFavourite(secondDoctor, saved.value.id)).toEqual({ ok: true, value: null });
    expect(await removeFavourite(secondDoctor, saved.value.id)).toMatchObject({ ok: false, code: "not_found" });
    expect(await removeFavourite(secondDoctor, "not-a-uuid")).toMatchObject({ ok: false, code: "not_found" });
  });

  it("is limited to prescribers", async () => {
    const saved = await saveFavourite(A.as("doctor"), { drugName: `${P} ROLE CHECK` });
    if (!saved.ok) throw new Error(saved.message);
    for (const role of ["nurse", "pharmacist", "accountant", "reception"]) {
      expect(await saveFavourite(A.as(role), line)).toMatchObject({ ok: false, code: "forbidden" });
      expect(await listFavourites(A.as(role))).toMatchObject({ ok: false, code: "forbidden" });
      expect(await removeFavourite(A.as(role), saved.value.id)).toMatchObject({ ok: false, code: "forbidden" });
    }
    // The forbidden attempts removed nothing.
    const list = await listFavourites(A.as("doctor"));
    expect(list.ok && list.value.some((f) => f.id === saved.value.id)).toBe(true);
  });

  it("refuses a NUL in a favourite rather than stripping it", async () => {
    const NUL = "\u0000";
    expect([...NUL]).toHaveLength(1);
    expect(await saveFavourite(A.as("doctor"), { drugName: `Bad${NUL}Tab` })).toMatchObject({
      ok: false,
      code: "invalid",
      field: "drugName",
    });
    expect(await saveFavourite(A.as("doctor"), { drugName: "Good Tab", remarks: `Bad${NUL}note` })).toMatchObject({
      ok: false,
      code: "invalid",
      field: "remarks",
    });
  });

  it("holds the cap under concurrent saves", async () => {
    const { ctx: fourth, doctorId } = await extraDoctor(A.tenantId, "cat-fourth");
    await adminDb.insert(medicineFavourites).values(
      Array.from({ length: 199 }, (_, i) => ({
        tenantId: A.tenantId,
        doctorId,
        nameKey: `race ${i}`,
        drugName: `Race ${i}`,
      })),
    );
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => saveFavourite(fourth, { drugName: `Race New ${i}` })),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    for (const r of results.filter((x) => !x.ok)) expect(r).toMatchObject({ ok: false, code: "invalid", field: "favourites" });
    const [{ n }] = await adminDb
      .select({ n: sql<number>`count(*)::int` })
      .from(medicineFavourites)
      .where(eq(medicineFavourites.doctorId, doctorId));
    expect(n).toBe(200);
  });
});

describe("suggestTerms", () => {
  it("suggests terms of the requested kind only", async () => {
    expect(await suggestTerms(A.as("doctor"), { kind: "complaint", q: `${P} fever` })).toEqual({
      ok: true,
      value: [`${P} FEVER WITH CHILLS`],
    });
    expect(await suggestTerms(A.as("doctor"), { kind: "test", q: `${P} CB` })).toEqual({ ok: true, value: [`${P} CBC`] });
    expect(await suggestTerms(A.as("doctor"), { kind: "complaint", q: `${P} CB` })).toEqual({ ok: true, value: [] });
  });

  it("rejects unknown kinds, returns nothing for blank input, and enforces roles", async () => {
    expect(await suggestTerms(A.as("doctor"), { kind: "spell", q: "x" })).toMatchObject({ ok: false, code: "invalid", field: "kind" });
    expect(await suggestTerms(A.as("doctor"), { kind: "test", q: "   " })).toEqual({ ok: true, value: [] });
    expect(await suggestTerms(A.as("reception"), { kind: "test", q: "cbc" })).toMatchObject({ ok: false, code: "forbidden" });
  });

  it("allows nurses and pharmacists and refuses accountants and reception", async () => {
    for (const role of ["nurse", "pharmacist"]) {
      expect(await suggestTerms(A.as(role), { kind: "test", q: `${P} CB` })).toEqual({ ok: true, value: [`${P} CBC`] });
    }
    for (const role of ["accountant", "reception"]) {
      expect(await suggestTerms(A.as(role), { kind: "test", q: `${P} CB` })).toMatchObject({ ok: false, code: "forbidden" });
    }
  });

  it("never throws on missing or hostile options", async () => {
    const suggest = suggestTerms as (ctx: ServiceContext, opts?: unknown) => ReturnType<typeof suggestTerms>;
    for (const opts of [null, undefined, "test", 5, {}, { kind: null }, { kind: ["test"] }]) {
      expect(await suggest(A.as("doctor"), opts)).toMatchObject({ ok: false, code: "invalid", field: "kind" });
    }
  });
});
