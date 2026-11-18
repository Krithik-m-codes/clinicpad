import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import { adminDb } from "@/server/db/admin";
import { withTenant } from "@/server/db/tenant";
import { pgErrorInfo } from "@/server/db/errors";
import {
  branches,
  clinics,
  doctors,
  patients,
  prescriptions,
  templates,
  templateVersions,
  tenants,
  users,
  visits,
} from "@/server/db/schema";

// Migration 0010: visits.doctor_id, visits.branch_id and prescriptions.template_version_id had no foreign key at
// all, so a row could point at another clinic's doctor, branch or template version. They become composite
// (tenant_id, x_id) keys with ON DELETE SET NULL (x_id), and a user gets at most one doctor profile per clinic.

const stamp = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
let tenantA = "";
let tenantB = "";
const userIds: string[] = [];

type Conn = Pick<typeof adminDb, "insert" | "update">;
const connections: { label: string; run: <T>(fn: (c: Conn) => Promise<T>) => Promise<T> }[] = [
  { label: "the app role (RLS-bound, tenant A)", run: (fn) => withTenant(tenantA, fn) },
  { label: "the admin connection", run: (fn) => fn(adminDb) },
];

async function rejection(promise: Promise<unknown>) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error, "expected the statement to be rejected").not.toBeNull();
  return pgErrorInfo(error);
}

/** A clinic, branch, doctor, template version and patient, all in one tenant. */
async function world(tenantId: string) {
  const [clinic] = await adminDb.insert(clinics).values({ tenantId, name: "Ref clinic" }).returning();
  const [branch] = await adminDb.insert(branches).values({ tenantId, clinicId: clinic.id, name: "Ref branch" }).returning();
  const [doctor] = await adminDb.insert(doctors).values({ tenantId, regNo: "REF-1" }).returning();
  const [template] = await adminDb.insert(templates).values({ tenantId, name: "Ref template" }).returning();
  const [version] = await adminDb
    .insert(templateVersions)
    .values({ tenantId, templateId: template.id, version: 1 })
    .returning();
  const [patient] = await adminDb.insert(patients).values({ tenantId, name: "Ref patient" }).returning();
  return { clinic, branch, doctor, template, version, patient };
}
type World = Awaited<ReturnType<typeof world>>;

/** A draft visit and prescription that point at w's doctor, branch and template version. */
async function draftFor(tenantId: string, w: World) {
  const [visit] = await adminDb
    .insert(visits)
    .values({ tenantId, patientId: w.patient.id, doctorId: w.doctor.id, branchId: w.branch.id, status: "draft" })
    .returning();
  const [rx] = await adminDb
    .insert(prescriptions)
    .values({ tenantId, visitId: visit.id, status: "draft", templateVersionId: w.version.id })
    .returning();
  return { visit, rx };
}

/** Freeze the records the way the services do: the prescription first, then its visit. */
async function finalize(rxId: string, visitId: string) {
  await adminDb.update(prescriptions).set({ status: "finalized", finalizedAt: new Date() }).where(eq(prescriptions.id, rxId));
  await adminDb.update(visits).set({ status: "finalized", finalizedAt: new Date() }).where(eq(visits.id, visitId));
}

async function newUser(label: string): Promise<string> {
  const [user] = await adminDb
    .insert(users)
    .values({ email: `${label}-${stamp}@example.com`, name: "Dr Ref", passwordHash: "not-a-real-hash" })
    .returning();
  userIds.push(user.id);
  return user.id;
}

beforeAll(async () => {
  const [a] = await adminDb.insert(tenants).values({ name: "Refs A", slug: `refs-a-${stamp}` }).returning();
  const [b] = await adminDb.insert(tenants).values({ name: "Refs B", slug: `refs-b-${stamp}` }).returning();
  tenantA = a.id;
  tenantB = b.id;
});

afterAll(async () => {
  try {
    await adminDb.delete(tenants).where(inArray(tenants.id, [tenantA, tenantB].filter(Boolean)));
  } finally {
    if (userIds.length > 0) await adminDb.delete(users).where(inArray(users.id, userIds));
  }
});

describe.each(connections)("cross-clinic references through $label", (connection) => {
  it("rejects a visit pointing at another clinic's doctor or branch, as an INSERT and as an UPDATE", async () => {
    const own = await world(tenantA);
    const foreign = await world(tenantB);
    const { visit } = await draftFor(tenantA, own);

    const doctorInsert = await rejection(
      connection.run((c) => c.insert(visits).values({ tenantId: tenantA, patientId: own.patient.id, doctorId: foreign.doctor.id })),
    );
    expect(doctorInsert).toMatchObject({ code: "23503", constraint: "visits_doctor_fk" });
    const branchUpdate = await rejection(
      connection.run((c) => c.update(visits).set({ branchId: foreign.branch.id }).where(eq(visits.id, visit.id))),
    );
    expect(branchUpdate).toMatchObject({ code: "23503", constraint: "visits_branch_fk" });
  });

  it("rejects a prescription pointing at another clinic's template version", async () => {
    const own = await world(tenantA);
    const foreign = await world(tenantB);
    const { visit, rx } = await draftFor(tenantA, own);

    const insert = await rejection(
      connection.run((c) =>
        c.insert(prescriptions).values({ tenantId: tenantA, visitId: visit.id, templateVersionId: foreign.version.id }),
      ),
    );
    expect(insert).toMatchObject({ code: "23503", constraint: "prescriptions_template_version_fk" });
    const update = await rejection(
      connection.run((c) =>
        c.update(prescriptions).set({ templateVersionId: foreign.version.id }).where(eq(prescriptions.id, rx.id)),
      ),
    );
    expect(update).toMatchObject({ code: "23503", constraint: "prescriptions_template_version_fk" });
  });

  it("still accepts same-clinic references and missing ones", async () => {
    const own = await world(tenantA);
    const rows = await connection.run((c) =>
      c
        .insert(visits)
        .values({ tenantId: tenantA, patientId: own.patient.id, doctorId: own.doctor.id, branchId: own.branch.id })
        .returning({ id: visits.id }),
    );
    expect(rows).toHaveLength(1);
    const bare = await connection.run((c) =>
      c.insert(visits).values({ tenantId: tenantA, patientId: own.patient.id }).returning({ id: visits.id }),
    );
    expect(bare).toHaveLength(1);
  });
});

describe("one doctor profile per user per clinic", () => {
  it("refuses a second profile for the same user in the same clinic only", async () => {
    const userId = await newUser("one-profile");
    await adminDb.insert(doctors).values({ tenantId: tenantA, userId });
    const second = await rejection(adminDb.insert(doctors).values({ tenantId: tenantA, userId }));
    expect(second).toMatchObject({ code: "23505", constraint: "doctors_tenant_user_uq" });
    // The same user may be a doctor in another clinic, and profiles without a user do not collide.
    await adminDb.insert(doctors).values({ tenantId: tenantB, userId });
    await adminDb.insert(doctors).values([{ tenantId: tenantA }, { tenantId: tenantA }]);
  });
});

describe("delete rules", () => {
  it("nulls only the reference (never tenant_id) when a doctor, branch, or template of a draft is deleted", async () => {
    const own = await world(tenantA);
    const { visit, rx } = await draftFor(tenantA, own);

    await adminDb.delete(doctors).where(eq(doctors.id, own.doctor.id));
    await adminDb.delete(branches).where(eq(branches.id, own.branch.id));
    await adminDb.delete(templates).where(eq(templates.id, own.template.id)); // cascades to its versions

    const [v] = await adminDb.select().from(visits).where(eq(visits.id, visit.id));
    expect(v).toMatchObject({ tenantId: tenantA, doctorId: null, branchId: null });
    const [p] = await adminDb.select().from(prescriptions).where(eq(prescriptions.id, rx.id));
    expect(p).toMatchObject({ tenantId: tenantA, templateVersionId: null });
  });

  it("refuses to delete a doctor, branch, or template version that a finalized record references", async () => {
    const own = await world(tenantA);
    const { visit, rx } = await draftFor(tenantA, own);
    await finalize(rx.id, visit.id);

    // ON DELETE SET NULL is an UPDATE of the signed row, which the immutability triggers refuse.
    expect((await rejection(adminDb.delete(doctors).where(eq(doctors.id, own.doctor.id)))).code).toBe("23000");
    expect((await rejection(adminDb.delete(branches).where(eq(branches.id, own.branch.id)))).code).toBe("23000");
    expect((await rejection(adminDb.delete(templateVersions).where(eq(templateVersions.id, own.version.id)))).code).toBe(
      "23000",
    );

    const [v] = await adminDb.select().from(visits).where(eq(visits.id, visit.id));
    expect(v).toMatchObject({ doctorId: own.doctor.id, branchId: own.branch.id });
    const [p] = await adminDb.select().from(prescriptions).where(eq(prescriptions.id, rx.id));
    expect(p.templateVersionId).toBe(own.version.id);
  });

  it("still offboards a tenant whose signed records reference its doctor, branch, and template version", async () => {
    const [t] = await adminDb.insert(tenants).values({ name: "Refs offboard", slug: `refs-off-${stamp}` }).returning();
    const w = await world(t.id);
    const { visit, rx } = await draftFor(t.id, w);
    await finalize(rx.id, visit.id);

    // The tenant-level cascades delete visits and prescriptions before the nested SET NULL actions run.
    await adminDb.delete(tenants).where(eq(tenants.id, t.id));
    expect(await adminDb.select().from(visits).where(eq(visits.tenantId, t.id))).toHaveLength(0);
    expect(await adminDb.select().from(prescriptions).where(eq(prescriptions.tenantId, t.id))).toHaveLength(0);
    expect(await adminDb.select().from(doctors).where(eq(doctors.tenantId, t.id))).toHaveLength(0);
  });

  it("declares each new key as SET NULL on its own column only", async () => {
    const rows = await adminDb.execute<{ conname: string; on_delete: string; set_cols: string[] | null }>(sql`
      select c.conname::text as conname,
             c.confdeltype::text as on_delete,
             (select array_agg(a.attname::text order by k.ord)
                from unnest(c.confdelsetcols) with ordinality k(attnum, ord)
                join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum) as set_cols
        from pg_constraint c
       where c.connamespace = 'public'::regnamespace
         and c.conname in ('visits_doctor_fk', 'visits_branch_fk', 'prescriptions_template_version_fk')
       order by c.conname`);
    expect([...rows]).toEqual([
      { conname: "prescriptions_template_version_fk", on_delete: "n", set_cols: ["template_version_id"] },
      { conname: "visits_branch_fk", on_delete: "n", set_cols: ["branch_id"] },
      { conname: "visits_doctor_fk", on_delete: "n", set_cols: ["doctor_id"] },
    ]);
  });
});
