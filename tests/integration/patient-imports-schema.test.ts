// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { adminDb } from "@/server/db/admin";
import { withTenant } from "@/server/db/tenant";
import { pgErrorInfo } from "@/server/db/errors";
import { patientImports, patients, tenants } from "@/server/db/schema";

const stamp = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
let A = "";
let B = "";

async function expectCode(promise: Promise<unknown>, code: string, constraint?: string) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error, "expected the statement to be rejected").not.toBeNull();
  const info = pgErrorInfo(error);
  expect(info.code).toBe(code);
  if (constraint) expect(info.constraint).toBe(constraint);
}

function jobValues(tenantId: string, overrides: Partial<typeof patientImports.$inferInsert> = {}) {
  return {
    tenantId,
    fileSha256: "c".repeat(64),
    rowCount: 3,
    createdCount: 3,
    filledCount: 0,
    skippedCount: 0,
    alreadyImportedCount: 0,
    invalidCount: 0,
    ...overrides,
  };
}

async function jobIn(tenantId: string): Promise<string> {
  const [row] = await adminDb.insert(patientImports).values(jobValues(tenantId)).returning({ id: patientImports.id });
  return row.id;
}

beforeAll(async () => {
  const [a] = await adminDb.insert(tenants).values({ name: "ImpA", slug: `imp-a-${stamp}` }).returning();
  const [b] = await adminDb.insert(tenants).values({ name: "ImpB", slug: `imp-b-${stamp}` }).returning();
  A = a.id;
  B = b.id;
});

afterAll(async () => {
  // Offboarding must still remove import jobs and the patients that point at them.
  try {
    await adminDb.delete(tenants).where(eq(tenants.id, A));
  } finally {
    await adminDb.delete(tenants).where(eq(tenants.id, B));
  }
  expect(await adminDb.select().from(patientImports).where(eq(patientImports.tenantId, A))).toHaveLength(0);
  expect(await adminDb.select().from(patients).where(eq(patients.tenantId, A))).toHaveLength(0);
});

describe("patient_imports", () => {
  it("is tenant-isolated and append-only for the application role", async () => {
    await withTenant(A, (tx) => tx.insert(patientImports).values(jobValues(A)));
    expect((await withTenant(A, (tx) => tx.select().from(patientImports))).length).toBeGreaterThan(0);
    expect(await withTenant(B, (tx) => tx.select().from(patientImports))).toHaveLength(0);

    await expectCode(withTenant(A, (tx) => tx.update(patientImports).set({ rowCount: 99 })), "42501");
    await expectCode(withTenant(A, (tx) => tx.delete(patientImports)), "42501");
  });

  it("is immutable on the admin connection too, while the tenant exists", async () => {
    const id = await jobIn(A);
    await expectCode(adminDb.update(patientImports).set({ createdCount: 2, skippedCount: 1 }).where(eq(patientImports.id, id)), "23000");
    await expectCode(adminDb.delete(patientImports).where(eq(patientImports.id, id)), "23000");
  });

  it("refuses rows written for another tenant", async () => {
    await expectCode(withTenant(B, (tx) => tx.insert(patientImports).values(jobValues(A))), "42501");
  });

  it.each([
    ["a malformed file hash", { fileSha256: "not-a-hash" }, "patient_imports_sha256_check"],
    ["counts that do not add up to the rows", { createdCount: 2 }, "patient_imports_counts_check"],
    ["more than 5,000 rows", { rowCount: 5001, createdCount: 5001 }, "patient_imports_counts_check"],
  ])("rejects %s", async (_label, overrides, constraint) => {
    await expectCode(adminDb.insert(patientImports).values(jobValues(A, overrides)), "23514", constraint);
  });
});

describe("patients.import_id", () => {
  it("only points at this clinic's own import (composite foreign key)", async () => {
    const mine = await jobIn(A);
    const theirs = await jobIn(B);
    await adminDb.insert(patients).values({ tenantId: A, name: "Own Import", importId: mine });
    await expectCode(adminDb.insert(patients).values({ tenantId: A, name: "Foreign Import", importId: theirs }), "23503", "patients_import_fk");
  });

  it("keeps a row key unique per clinic and in the expected shape", async () => {
    const key = "d".repeat(64);
    await adminDb.insert(patients).values({ tenantId: A, name: "Keyed", importRowKey: key });
    await expectCode(adminDb.insert(patients).values({ tenantId: A, name: "Keyed Twin", importRowKey: key }), "23505", "patients_import_row_key_uq");
    await adminDb.insert(patients).values({ tenantId: B, name: "Keyed Elsewhere", importRowKey: key });
    await expectCode(adminDb.insert(patients).values({ tenantId: A, name: "Bad Key", importRowKey: "XYZ" }), "23514", "patients_import_row_key_check");
  });
});
