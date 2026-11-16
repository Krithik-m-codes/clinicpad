import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { adminDb } from "@/server/db/admin";
import { withTenant } from "@/server/db/tenant";
import { pgErrorInfo } from "@/server/db/errors";
import {
  branches,
  clinics,
  doctors,
  patients,
  prescriptionItems,
  prescriptions,
  templates,
  templateVersions,
  tenants,
  visits,
} from "@/server/db/schema";

// RLS only checks a row's OWN tenant_id, and foreign-key checks run without RLS. A single-column key therefore
// happily points at another tenant's row. These tests pin the composite (tenant_id, x_id) keys that close that.

let tenantA = "";
let tenantB = "";

type Conn = Pick<typeof adminDb, "insert" | "update">;
type Records = Awaited<ReturnType<typeof seedRecords>>;

/** A patient, a draft visit, a draft prescription and one item, all in one tenant. */
async function seedRecords(tenant: string) {
  const [patient] = await adminDb.insert(patients).values({ tenantId: tenant, name: "Tenant FK P" }).returning();
  const [visit] = await adminDb
    .insert(visits)
    .values({ tenantId: tenant, patientId: patient.id, status: "draft" })
    .returning();
  const [rx] = await adminDb
    .insert(prescriptions)
    .values({ tenantId: tenant, visitId: visit.id, rxNo: null, status: "draft" })
    .returning();
  const [item] = await adminDb
    .insert(prescriptionItems)
    .values({ tenantId: tenant, prescriptionId: rx.id, drugName: "Paracetamol" })
    .returning();
  return { patient, visit, rx, item };
}

/** Freeze the records the way the services will: the prescription first, then its visit. */
async function finalizeRecords({ rx, visit }: Records) {
  await adminDb.update(prescriptions).set({ status: "finalized", finalizedAt: new Date() }).where(eq(prescriptions.id, rx.id));
  await adminDb.update(visits).set({ status: "finalized", finalizedAt: new Date() }).where(eq(visits.id, visit.id));
}

/** Tenant A's draft records (own, plus a spare to move things to) and tenant B's FINALIZED records. */
async function context() {
  const own = await seedRecords(tenantA);
  const spare = await seedRecords(tenantA);
  const foreign = await seedRecords(tenantB);
  await finalizeRecords(foreign);
  return { own, spare, foreign };
}
type Context = Awaited<ReturnType<typeof context>>;

async function rejection(promise: Promise<unknown>) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error, "expected the statement to be rejected").not.toBeNull();
  return pgErrorInfo(error);
}

/** 23503, and (when given) raised by that very constraint rather than by something else. */
async function expectForeignKeyViolation(promise: Promise<unknown>, constraint: string | null) {
  const info = await rejection(promise);
  expect(info.code).toBe("23503");
  if (constraint) expect(info.constraint).toBe(constraint);
}

/** Nothing of tenant A's hangs off tenant B's records. */
async function expectUntouched(foreign: Records) {
  const [visitsOfPatient, rxOfVisit, amendmentsOfRx, itemsOfRx] = await Promise.all([
    adminDb.select({ id: visits.id }).from(visits).where(eq(visits.patientId, foreign.patient.id)),
    adminDb.select({ id: prescriptions.id }).from(prescriptions).where(eq(prescriptions.visitId, foreign.visit.id)),
    adminDb.select({ id: prescriptions.id }).from(prescriptions).where(eq(prescriptions.parentPrescriptionId, foreign.rx.id)),
    adminDb.select({ id: prescriptionItems.id }).from(prescriptionItems).where(eq(prescriptionItems.prescriptionId, foreign.rx.id)),
  ]);
  expect(visitsOfPatient.map((r) => r.id)).toEqual([foreign.visit.id]);
  expect(rxOfVisit.map((r) => r.id)).toEqual([foreign.rx.id]);
  expect(amendmentsOfRx).toEqual([]);
  expect(itemsOfRx.map((r) => r.id)).toEqual([foreign.item.id]);
}

beforeAll(async () => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const [a] = await adminDb.insert(tenants).values({ name: "TenantFK A", slug: `tfk-a-${stamp}` }).returning();
  const [b] = await adminDb.insert(tenants).values({ name: "TenantFK B", slug: `tfk-b-${stamp}` }).returning();
  tenantA = a.id;
  tenantB = b.id;
});

afterAll(async () => {
  try {
    if (tenantA) await adminDb.delete(tenants).where(eq(tenants.id, tenantA));
  } finally {
    if (tenantB) await adminDb.delete(tenants).where(eq(tenants.id, tenantB));
  }
});

/** The two ways a row can reach the database: through the RLS-bound app role, and through the admin connection. */
const connections: { label: string; run: <T>(fn: (c: Conn) => Promise<T>) => Promise<T> }[] = [
  { label: "the app role (RLS-bound, tenant A)", run: (fn) => withTenant(tenantA, fn) },
  { label: "the admin connection (tenant_id = A)", run: (fn) => fn(adminDb) },
];

type Relation = {
  name: string;
  /** The foreign key this relation is expected to trip. null: a trigger answers first, so no constraint is named. */
  constraint: string | null;
  /** Tenant A's row pointing at tenant B's parent, as a new row and as an existing row re-pointed. */
  crossInsert: (c: Conn, x: Context) => Promise<unknown>;
  crossRepoint: (c: Conn, x: Context) => Promise<unknown>;
  /** The same two operations, against a parent in tenant A. */
  sameInsert: (c: Conn, x: Context) => Promise<{ id: string }[]>;
  sameRepoint: (c: Conn, x: Context) => Promise<{ id: string }[]>;
};

const relations: Relation[] = [
  {
    name: "visits.patient_id -> patients (restrict)",
    constraint: "visits_patient_fk",
    crossInsert: (c, x) => c.insert(visits).values({ tenantId: tenantA, patientId: x.foreign.patient.id }),
    crossRepoint: (c, x) => c.update(visits).set({ patientId: x.foreign.patient.id }).where(eq(visits.id, x.own.visit.id)),
    sameInsert: (c, x) =>
      c.insert(visits).values({ tenantId: tenantA, patientId: x.own.patient.id }).returning({ id: visits.id }),
    sameRepoint: (c, x) =>
      c
        .update(visits)
        .set({ patientId: x.spare.patient.id })
        .where(eq(visits.id, x.own.visit.id))
        .returning({ id: visits.id }),
  },
  {
    name: "prescriptions.visit_id -> visits (cascade)",
    constraint: "prescriptions_visit_fk",
    crossInsert: (c, x) => c.insert(prescriptions).values({ tenantId: tenantA, visitId: x.foreign.visit.id, rxNo: null }),
    crossRepoint: (c, x) => c.update(prescriptions).set({ visitId: x.foreign.visit.id }).where(eq(prescriptions.id, x.own.rx.id)),
    sameInsert: (c, x) =>
      c.insert(prescriptions).values({ tenantId: tenantA, visitId: x.own.visit.id, rxNo: null }).returning({ id: prescriptions.id }),
    sameRepoint: (c, x) =>
      c
        .update(prescriptions)
        .set({ visitId: x.spare.visit.id })
        .where(eq(prescriptions.id, x.own.rx.id))
        .returning({ id: prescriptions.id }),
  },
  {
    name: "prescriptions.parent_prescription_id -> prescriptions (no action, nullable)",
    constraint: "prescriptions_parent_fk",
    crossInsert: (c, x) =>
      c.insert(prescriptions).values({
        tenantId: tenantA,
        visitId: x.own.visit.id,
        rxNo: null,
        version: 2,
        parentPrescriptionId: x.foreign.rx.id,
        amendmentReason: "cross-tenant amendment",
      }),
    crossRepoint: (c, x) =>
      c.update(prescriptions).set({ parentPrescriptionId: x.foreign.rx.id }).where(eq(prescriptions.id, x.own.rx.id)),
    sameInsert: async (c, x) => {
      await finalizeRecords(x.spare);
      return c
        .insert(prescriptions)
        .values({
          tenantId: tenantA,
          visitId: x.own.visit.id,
          rxNo: null,
          version: 2,
          parentPrescriptionId: x.spare.rx.id,
          amendmentReason: "same-tenant amendment",
        })
        .returning({ id: prescriptions.id });
    },
    sameRepoint: async (c, x) => {
      await finalizeRecords(x.spare);
      return c
        .update(prescriptions)
        .set({ parentPrescriptionId: x.spare.rx.id })
        .where(eq(prescriptions.id, x.own.rx.id))
        .returning({ id: prescriptions.id });
    },
  },
  {
    name: "prescription_items.prescription_id -> prescriptions (cascade)",
    // The item trigger answers 23503 before the key is even checked; the key itself is proven further down.
    constraint: null,
    crossInsert: (c, x) =>
      c.insert(prescriptionItems).values({ tenantId: tenantA, prescriptionId: x.foreign.rx.id, drugName: "Intruder" }),
    crossRepoint: (c, x) =>
      c.update(prescriptionItems).set({ prescriptionId: x.foreign.rx.id }).where(eq(prescriptionItems.id, x.own.item.id)),
    sameInsert: (c, x) =>
      c
        .insert(prescriptionItems)
        .values({ tenantId: tenantA, prescriptionId: x.own.rx.id, drugName: "Own item" })
        .returning({ id: prescriptionItems.id }),
    sameRepoint: (c, x) =>
      c
        .update(prescriptionItems)
        .set({ prescriptionId: x.spare.rx.id })
        .where(eq(prescriptionItems.id, x.own.item.id))
        .returning({ id: prescriptionItems.id }),
  },
];

describe.each(relations)("$name", (relation) => {
  describe.each(connections)("through $label", (connection) => {
    it("rejects an INSERT that references another tenant's row with 23503", async () => {
      const x = await context();
      await expectForeignKeyViolation(connection.run((c) => relation.crossInsert(c, x)), relation.constraint);
      await expectUntouched(x.foreign);
    });

    it("rejects an UPDATE that re-points a row at another tenant's row with 23503", async () => {
      const x = await context();
      await expectForeignKeyViolation(connection.run((c) => relation.crossRepoint(c, x)), relation.constraint);
      await expectUntouched(x.foreign);
    });

    it("still accepts an INSERT that references a row of the same tenant", async () => {
      const x = await context();
      const rows = await connection.run((c) => relation.sameInsert(c, x));
      expect(rows, "the INSERT must create exactly one row").toHaveLength(1);
    });

    it("still accepts an UPDATE that re-points a row inside the same tenant", async () => {
      const x = await context();
      const rows = await connection.run((c) => relation.sameRepoint(c, x));
      expect(rows, "the UPDATE must change exactly one row").toHaveLength(1);
    });
  });
});

describe("prescription_items: the foreign key itself enforces the tenant", () => {
  // The item trigger raises 23503 first, so with it in place the key is never what rejects the row. Switch the
  // trigger off inside a transaction that always ends in a rollback, so nothing outlives the test.
  class RolledBack extends Error {}

  async function withItemTriggerOff(statement: (tx: Conn) => Promise<unknown>) {
    return adminDb
      .transaction(async (tx) => {
        await tx.execute(sql`alter table public.prescription_items disable trigger prescription_items_immutable`);
        await statement(tx);
        throw new RolledBack();
      })
      .then(
        () => null,
        (e: unknown) => e,
      );
  }

  async function expectKeyRejects(error: unknown) {
    expect(error instanceof RolledBack, "the statement went through: the key did not reject it").toBe(false);
    const info = pgErrorInfo(error);
    expect(info.code).toBe("23503");
    expect(info.constraint).toBe("rx_items_prescription_fk");
    const [trigger] = await adminDb.execute<{ tgenabled: string }>(
      sql`select tgenabled from pg_trigger where tgname = 'prescription_items_immutable'`,
    );
    expect(trigger.tgenabled, "the item trigger must be back on after the rollback").toBe("O");
  }

  it("rejects an item INSERT under another tenant's prescription", async () => {
    const x = await context();
    const error = await withItemTriggerOff((tx) =>
      tx.insert(prescriptionItems).values({ tenantId: tenantA, prescriptionId: x.foreign.rx.id, drugName: "Intruder" }),
    );
    await expectKeyRejects(error);
  });

  it("rejects re-pointing an item at another tenant's prescription", async () => {
    const x = await context();
    const error = await withItemTriggerOff((tx) =>
      tx.update(prescriptionItems).set({ prescriptionId: x.foreign.rx.id }).where(eq(prescriptionItems.id, x.own.item.id)),
    );
    await expectKeyRejects(error);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The remaining Phase 0 relations: branches -> clinics, template_versions -> templates, doctors -> branches.

/** A clinic with a branch and a doctor based there, and a template with one version, all in one tenant. */
async function seedPhase0(tenant: string, templateVersion = 1) {
  const [clinic] = await adminDb.insert(clinics).values({ tenantId: tenant, name: "Tenant FK clinic" }).returning();
  const [branch] = await adminDb
    .insert(branches)
    .values({ tenantId: tenant, clinicId: clinic.id, name: "Tenant FK branch" })
    .returning();
  const [doctor] = await adminDb
    .insert(doctors)
    .values({ tenantId: tenant, primaryBranchId: branch.id, regNo: "FK-1" })
    .returning();
  const [template] = await adminDb.insert(templates).values({ tenantId: tenant, name: "Tenant FK template" }).returning();
  const [version] = await adminDb
    .insert(templateVersions)
    .values({ tenantId: tenant, templateId: template.id, version: templateVersion })
    .returning();
  return { clinic, branch, doctor, template, version };
}
type Phase0Records = Awaited<ReturnType<typeof seedPhase0>>;

/** Tenant A's own records (plus a spare to move things to; its version number differs) and tenant B's. */
async function phase0Context() {
  const own = await seedPhase0(tenantA, 1);
  const spare = await seedPhase0(tenantA, 2);
  const foreign = await seedPhase0(tenantB, 1);
  return { own, spare, foreign };
}
type Phase0Context = Awaited<ReturnType<typeof phase0Context>>;

/** Nothing of tenant A's hangs off tenant B's clinic, branch or template. */
async function expectPhase0Untouched(foreign: Phase0Records) {
  const [branchesOfClinic, doctorsOfBranch, versionsOfTemplate] = await Promise.all([
    adminDb.select({ id: branches.id }).from(branches).where(eq(branches.clinicId, foreign.clinic.id)),
    adminDb.select({ id: doctors.id }).from(doctors).where(eq(doctors.primaryBranchId, foreign.branch.id)),
    adminDb.select({ id: templateVersions.id }).from(templateVersions).where(eq(templateVersions.templateId, foreign.template.id)),
  ]);
  expect(branchesOfClinic.map((r) => r.id)).toEqual([foreign.branch.id]);
  expect(doctorsOfBranch.map((r) => r.id)).toEqual([foreign.doctor.id]);
  expect(versionsOfTemplate.map((r) => r.id)).toEqual([foreign.version.id]);
}

type Phase0Relation = {
  name: string;
  constraint: string;
  crossInsert: (c: Conn, x: Phase0Context) => Promise<unknown>;
  crossRepoint: (c: Conn, x: Phase0Context) => Promise<unknown>;
  sameInsert: (c: Conn, x: Phase0Context) => Promise<{ id: string }[]>;
  sameRepoint: (c: Conn, x: Phase0Context) => Promise<{ id: string }[]>;
};

const phase0Relations: Phase0Relation[] = [
  {
    name: "branches.clinic_id -> clinics (cascade)",
    constraint: "branches_clinic_fk",
    crossInsert: (c, x) => c.insert(branches).values({ tenantId: tenantA, clinicId: x.foreign.clinic.id, name: "Intruder" }),
    crossRepoint: (c, x) => c.update(branches).set({ clinicId: x.foreign.clinic.id }).where(eq(branches.id, x.own.branch.id)),
    sameInsert: (c, x) =>
      c.insert(branches).values({ tenantId: tenantA, clinicId: x.own.clinic.id, name: "Own" }).returning({ id: branches.id }),
    sameRepoint: (c, x) =>
      c.update(branches).set({ clinicId: x.spare.clinic.id }).where(eq(branches.id, x.own.branch.id)).returning({ id: branches.id }),
  },
  {
    name: "template_versions.template_id -> templates (cascade)",
    constraint: "template_versions_template_fk",
    crossInsert: (c, x) =>
      c.insert(templateVersions).values({ tenantId: tenantA, templateId: x.foreign.template.id, version: 9 }),
    crossRepoint: (c, x) =>
      c
        .update(templateVersions)
        .set({ templateId: x.foreign.template.id, version: 9 })
        .where(eq(templateVersions.id, x.own.version.id)),
    sameInsert: (c, x) =>
      c
        .insert(templateVersions)
        .values({ tenantId: tenantA, templateId: x.own.template.id, version: 9 })
        .returning({ id: templateVersions.id }),
    sameRepoint: (c, x) =>
      c
        .update(templateVersions)
        .set({ templateId: x.spare.template.id, version: 9 })
        .where(eq(templateVersions.id, x.own.version.id))
        .returning({ id: templateVersions.id }),
  },
  {
    name: "doctors.primary_branch_id -> branches (set null, nullable)",
    constraint: "doctors_primary_branch_fk",
    crossInsert: (c, x) => c.insert(doctors).values({ tenantId: tenantA, primaryBranchId: x.foreign.branch.id }),
    crossRepoint: (c, x) =>
      c.update(doctors).set({ primaryBranchId: x.foreign.branch.id }).where(eq(doctors.id, x.own.doctor.id)),
    sameInsert: (c, x) =>
      c.insert(doctors).values({ tenantId: tenantA, primaryBranchId: x.own.branch.id }).returning({ id: doctors.id }),
    sameRepoint: (c, x) =>
      c.update(doctors).set({ primaryBranchId: x.spare.branch.id }).where(eq(doctors.id, x.own.doctor.id)).returning({ id: doctors.id }),
  },
];

describe.each(phase0Relations)("$name", (relation) => {
  describe.each(connections)("through $label", (connection) => {
    it("rejects an INSERT that references another tenant's row with 23503", async () => {
      const x = await phase0Context();
      await expectForeignKeyViolation(connection.run((c) => relation.crossInsert(c, x)), relation.constraint);
      await expectPhase0Untouched(x.foreign);
    });

    it("rejects an UPDATE that re-points a row at another tenant's row with 23503", async () => {
      const x = await phase0Context();
      await expectForeignKeyViolation(connection.run((c) => relation.crossRepoint(c, x)), relation.constraint);
      await expectPhase0Untouched(x.foreign);
    });

    it("still accepts an INSERT that references a row of the same tenant", async () => {
      const x = await phase0Context();
      const rows = await connection.run((c) => relation.sameInsert(c, x));
      expect(rows, "the INSERT must create exactly one row").toHaveLength(1);
    });

    it("still accepts an UPDATE that re-points a row inside the same tenant", async () => {
      const x = await phase0Context();
      const rows = await connection.run((c) => relation.sameRepoint(c, x));
      expect(rows, "the UPDATE must change exactly one row").toHaveLength(1);
    });
  });
});

describe("doctors.primary_branch_id stays optional", () => {
  it("accepts a doctor with no primary branch", async () => {
    const rows = await adminDb.insert(doctors).values({ tenantId: tenantA }).returning({ id: doctors.id });
    expect(rows).toHaveLength(1);
  });
});

describe("the Phase 0 delete rules still hold", () => {
  const deleters: { label: string; run: <T>(fn: (c: Pick<typeof adminDb, "delete" | "select">) => Promise<T>) => Promise<T> }[] = [
    { label: "the app role", run: (fn) => withTenant(tenantA, fn) },
    { label: "the admin connection", run: (fn) => fn(adminDb) },
  ];

  describe.each(deleters)("through $label", (deleter) => {
    it("deleting a clinic deletes its branches (cascade) and leaves the doctor's branch pointer null", async () => {
      const own = await seedPhase0(tenantA);
      const other = await seedPhase0(tenantA);
      await deleter.run((c) => c.delete(clinics).where(eq(clinics.id, own.clinic.id)));
      expect(await adminDb.select().from(branches).where(eq(branches.id, own.branch.id))).toHaveLength(0);
      expect(await adminDb.select().from(branches).where(eq(branches.id, other.branch.id))).toHaveLength(1);
      const [doctor] = await adminDb.select().from(doctors).where(eq(doctors.id, own.doctor.id));
      expect(doctor.primaryBranchId).toBeNull();
      expect(doctor.tenantId).toBe(tenantA);
    });

    it("deleting a template deletes its versions (cascade)", async () => {
      const own = await seedPhase0(tenantA);
      const other = await seedPhase0(tenantA);
      await deleter.run((c) => c.delete(templates).where(eq(templates.id, own.template.id)));
      expect(await adminDb.select().from(templateVersions).where(eq(templateVersions.id, own.version.id))).toHaveLength(0);
      expect(await adminDb.select().from(templateVersions).where(eq(templateVersions.id, other.version.id))).toHaveLength(1);
    });

    it("deleting a branch sets the doctor's primary_branch_id to NULL and keeps tenant_id", async () => {
      const own = await seedPhase0(tenantA);
      await deleter.run((c) => c.delete(branches).where(eq(branches.id, own.branch.id)));
      const [doctor] = await adminDb.select().from(doctors).where(eq(doctors.id, own.doctor.id));
      expect(doctor, "the doctor must survive the branch").toBeDefined();
      expect(doctor.primaryBranchId).toBeNull();
      expect(doctor.tenantId).toBe(tenantA);
    });
  });

  it("deleting tenant B's clinic never reaches tenant A's rows", async () => {
    const own = await seedPhase0(tenantA);
    const foreign = await seedPhase0(tenantB);
    await adminDb.delete(clinics).where(eq(clinics.id, foreign.clinic.id));
    expect(await adminDb.select().from(branches).where(eq(branches.id, foreign.branch.id))).toHaveLength(0);
    expect(await adminDb.select().from(branches).where(eq(branches.id, own.branch.id))).toHaveLength(1);
    const [doctor] = await adminDb.select().from(doctors).where(eq(doctors.id, own.doctor.id));
    expect(doctor.primaryBranchId).toBe(own.branch.id);
  });
});

describe("the probe that motivated the composite keys", () => {
  it("tenant A cannot hang records on tenant B's rows, and B's own amendment is not blocked", async () => {
    const b = await seedRecords(tenantB);
    await finalizeRecords(b);
    const a = await seedRecords(tenantA);

    // W1: a prescription under B's visit.
    await expectForeignKeyViolation(
      withTenant(tenantA, (tx) => tx.insert(prescriptions).values({ tenantId: tenantA, visitId: b.visit.id, rxNo: null })),
      "prescriptions_visit_fk",
    );
    // W2: a visit for B's patient.
    await expectForeignKeyViolation(
      withTenant(tenantA, (tx) => tx.insert(visits).values({ tenantId: tenantA, patientId: b.patient.id })),
      "visits_patient_fk",
    );
    // W3: an amendment of B's finalized prescription.
    await expectForeignKeyViolation(
      withTenant(tenantA, (tx) =>
        tx.insert(prescriptions).values({
          tenantId: tenantA,
          visitId: a.visit.id,
          rxNo: null,
          version: 2,
          parentPrescriptionId: b.rx.id,
          amendmentReason: "probe",
        }),
      ),
      "prescriptions_parent_fk",
    );
    await expectUntouched(b);

    // W4: with W3 refused, nothing of A's holds the partial unique index, so B can open its own amendment.
    await withTenant(tenantB, async (tx) => {
      const [visit] = await tx.insert(visits).values({ tenantId: tenantB, patientId: b.patient.id }).returning();
      await tx.insert(prescriptions).values({
        tenantId: tenantB,
        visitId: visit.id,
        rxNo: null,
        version: 2,
        parentPrescriptionId: b.rx.id,
        amendmentReason: "B amends its own prescription",
      });
    });
  });
});

describe("the foreign keys in the catalog", () => {
  type ForeignKeyRow = { conname: string; child_cols: string[]; parent_cols: string[]; on_delete: string };

  // Foreign keys into a tenant-owned table. Parents that carry tenant_id must be referenced as (tenant_id, id).
  async function foreignKeysIntoTenantOwnedTables() {
    return adminDb.execute<ForeignKeyRow>(sql`
      select c.conname::text as conname,
             (select array_agg(a.attname::text order by k.ord)
                from unnest(c.conkey) with ordinality k(attnum, ord)
                join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum) as child_cols,
             (select array_agg(a.attname::text order by k.ord)
                from unnest(c.confkey) with ordinality k(attnum, ord)
                join pg_attribute a on a.attrelid = c.confrelid and a.attnum = k.attnum) as parent_cols,
             case c.confdeltype when 'a' then 'NO ACTION' when 'r' then 'RESTRICT' when 'c' then 'CASCADE'
                                when 'n' then 'SET NULL' when 'd' then 'SET DEFAULT' end as on_delete
        from pg_constraint c
       where c.contype = 'f'
         and c.connamespace = 'public'::regnamespace
         and exists (select 1 from pg_attribute p
                      where p.attrelid = c.confrelid and p.attname = 'tenant_id' and not p.attisdropped)
       order by c.conname`);
  }

  // Single-column keys into a tenant-owned table that are tolerated. The list is EMPTY and must stay empty:
  // a new relation to a tenant-owned table uses a composite (tenant_id, x_id) key instead of an entry here.
  const knownSingleColumn: string[] = [];

  it("has no single-column key into a tenant-owned table", async () => {
    const rows = await foreignKeysIntoTenantOwnedTables();
    const singleColumn = rows
      .filter((r) => !(r.child_cols.length === 2 && r.child_cols[0] === "tenant_id" && r.parent_cols.join() === "tenant_id,id"))
      .map((r) => r.conname)
      .sort();
    expect(singleColumn).toEqual([...knownSingleColumn].sort());
  });

  it("keeps each converted key's delete rule", async () => {
    const rows = await foreignKeysIntoTenantOwnedTables();
    const rules = Object.fromEntries(rows.map((r) => [r.conname, r.on_delete]));
    expect(rules).toMatchObject({
      visits_patient_fk: "RESTRICT",
      prescriptions_visit_fk: "CASCADE",
      prescriptions_parent_fk: "NO ACTION",
      rx_items_prescription_fk: "CASCADE",
      branches_clinic_fk: "CASCADE",
      template_versions_template_fk: "CASCADE",
      doctors_primary_branch_fk: "SET NULL",
    });
  });

  it("nulls only primary_branch_id (not tenant_id) when a branch is deleted", async () => {
    const [row] = await adminDb.execute<{ set_cols: string[] | null }>(sql`
      select (select array_agg(a.attname::text order by k.ord)
                from unnest(c.confdelsetcols) with ordinality k(attnum, ord)
                join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum) as set_cols
        from pg_constraint c
       where c.conname = 'doctors_primary_branch_fk' and c.connamespace = 'public'::regnamespace`);
    expect(row?.set_cols).toEqual(["primary_branch_id"]);
  });

  it("still refuses to delete a patient who has visits (restrict)", async () => {
    const x = await seedRecords(tenantA);
    const info = await rejection(adminDb.delete(patients).where(eq(patients.id, x.patient.id)));
    expect(info.code).toBe("23503");
    expect(await adminDb.select().from(patients).where(eq(patients.id, x.patient.id))).toHaveLength(1);
  });
});
