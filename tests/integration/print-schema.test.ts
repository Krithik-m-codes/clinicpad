import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { adminDb } from "@/server/db/admin";
import { withTenant } from "@/server/db/tenant";
import { pgErrorInfo } from "@/server/db/errors";
import {
  clinicAssets,
  clinics,
  doctors,
  patients,
  prescriptionItems,
  prescriptionOutputs,
  prescriptions,
  tenants,
  users,
  visits,
} from "@/server/db/schema";
import { createClinicAccount } from "@/server/auth/create-clinic";

const stamp = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
let A = "";
let B = "";
let nextRxNo = 9100;

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

function assetValues(tenantId: string, label: string, overrides: Partial<typeof clinicAssets.$inferInsert> = {}) {
  const bytes = Buffer.from(`fake-image-${label}-${stamp}`);
  return {
    tenantId,
    kind: "logo",
    mime: "image/png",
    width: 120,
    height: 60,
    byteSize: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes,
    ...overrides,
  };
}

async function insertAsset(tenantId: string, label: string): Promise<string> {
  const [row] = await adminDb.insert(clinicAssets).values(assetValues(tenantId, label)).returning({ id: clinicAssets.id });
  return row.id;
}

/** A prescription with one item, left as a draft or moved to finalized the way Plan 1A's tests do. */
async function prescriptionIn(tenantId: string, status: "draft" | "finalized"): Promise<string> {
  const [patient] = await adminDb.insert(patients).values({ tenantId, name: "Print Schema Patient" }).returning();
  const [visit] = await adminDb.insert(visits).values({ tenantId, patientId: patient.id, status: "draft" }).returning();
  const [rx] = await adminDb.insert(prescriptions).values({ tenantId, visitId: visit.id, status: "draft" }).returning();
  await adminDb.insert(prescriptionItems).values({ tenantId, prescriptionId: rx.id, drugName: "Paracetamol" });
  if (status === "finalized") {
    nextRxNo += 1;
    await adminDb
      .update(prescriptions)
      .set({ status: "finalized", rxNo: nextRxNo, finalizedAt: new Date(), renderSnapshot: { v: 1, marker: "frozen" } })
      .where(eq(prescriptions.id, rx.id));
    await adminDb.update(visits).set({ status: "finalized", finalizedAt: new Date() }).where(eq(visits.id, visit.id));
  }
  return rx.id;
}

function outputValues(tenantId: string, prescriptionId: string, overrides: Partial<typeof prescriptionOutputs.$inferInsert> = {}) {
  return {
    tenantId,
    prescriptionId,
    kind: "browser_print",
    templateKey: "general",
    paperSize: "A4",
    htmlSha256: "a".repeat(64),
    ...overrides,
  };
}

beforeAll(async () => {
  const [a] = await adminDb.insert(tenants).values({ name: "PrintA", slug: `print-a-${stamp}` }).returning();
  const [b] = await adminDb.insert(tenants).values({ name: "PrintB", slug: `print-b-${stamp}` }).returning();
  A = a.id;
  B = b.id;
  await adminDb.insert(clinics).values([
    { tenantId: A, name: "Print Clinic A" },
    { tenantId: B, name: "Print Clinic B" },
  ]);
  await adminDb.insert(doctors).values([{ tenantId: A }, { tenantId: B }]);
});

afterAll(async () => {
  // Offboarding must still remove assets, outputs, and the clinics and doctors that point at assets.
  try {
    await adminDb.delete(tenants).where(eq(tenants.id, A));
  } finally {
    await adminDb.delete(tenants).where(eq(tenants.id, B));
  }
  expect(await adminDb.select().from(clinicAssets).where(eq(clinicAssets.tenantId, A))).toHaveLength(0);
  expect(await adminDb.select().from(prescriptionOutputs).where(eq(prescriptionOutputs.tenantId, A))).toHaveLength(0);
  expect(await adminDb.select().from(clinics).where(eq(clinics.tenantId, A))).toHaveLength(0);
});

describe("clinic_assets", () => {
  it("is tenant-isolated and append-only for the application role", async () => {
    await withTenant(A, (tx) => tx.insert(clinicAssets).values(assetValues(A, "app-insert")));
    expect((await withTenant(A, (tx) => tx.select().from(clinicAssets))).length).toBeGreaterThan(0);
    expect(await withTenant(B, (tx) => tx.select().from(clinicAssets))).toHaveLength(0);

    await expectCode(withTenant(A, (tx) => tx.update(clinicAssets).set({ width: 99 })), "42501");
    await expectCode(withTenant(A, (tx) => tx.delete(clinicAssets)), "42501");
  });

  it("is immutable on the admin connection too, while the tenant exists", async () => {
    const id = await insertAsset(A, "admin-immutable");
    await expectCode(adminDb.update(clinicAssets).set({ bytes: Buffer.from("x") }).where(eq(clinicAssets.id, id)), "23000");
    await expectCode(adminDb.update(clinicAssets).set({ width: 99 }).where(eq(clinicAssets.id, id)), "23000");
    await expectCode(adminDb.delete(clinicAssets).where(eq(clinicAssets.id, id)), "23000");
  });

  it("refuses rows written for another tenant", async () => {
    await expectCode(withTenant(B, (tx) => tx.insert(clinicAssets).values(assetValues(A, "leak"))), "42501");
  });

  it.each([
    ["an SVG", { mime: "image/svg+xml" }, "clinic_assets_mime_check"],
    ["an unknown kind", { kind: "letterhead" }, "clinic_assets_kind_check"],
    ["a size that does not match the bytes", { byteSize: 3 }, "clinic_assets_size_check"],
    ["an oversized image", { width: 5000 }, "clinic_assets_dimensions_check"],
    ["a tiny image", { height: 4 }, "clinic_assets_dimensions_check"],
    // Postgres reports the first failing check in name order: hash_matches precedes sha256_check.
    ["a malformed hash", { sha256: "not-a-hash" }, "clinic_assets_hash_matches_check"],
    ["a well-formed hash of other bytes", { sha256: "b".repeat(64) }, "clinic_assets_hash_matches_check"],
  ])("rejects %s", async (_label, overrides, constraint) => {
    await expectCode(adminDb.insert(clinicAssets).values(assetValues(A, `bad-${JSON.stringify(overrides)}`, overrides)), "23514", constraint);
  });

  it("rejects more than 512 KB", async () => {
    const bytes = Buffer.alloc(600 * 1024, 1);
    await expectCode(
      adminDb.insert(clinicAssets).values(
        assetValues(A, "huge", { bytes, byteSize: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }),
      ),
      "23514",
      "clinic_assets_size_check",
    );
  });

  it("de-duplicates identical uploads per tenant and kind", async () => {
    await adminDb.insert(clinicAssets).values(assetValues(A, "dup"));
    await expectCode(adminDb.insert(clinicAssets).values(assetValues(A, "dup")), "23505");
    // The same bytes as a signature, or in another clinic, are separate assets.
    await adminDb.insert(clinicAssets).values(assetValues(A, "dup", { kind: "signature" }));
    await adminDb.insert(clinicAssets).values(assetValues(B, "dup"));
  });
});

describe("clinic and doctor pad columns", () => {
  it("defaults the layout to General, A4, English", async () => {
    const [clinic] = await adminDb.select().from(clinics).where(eq(clinics.tenantId, A));
    expect(clinic).toMatchObject({ rxTemplate: "general", rxPaperSize: "A4", rxLabels: "en", logoAssetId: null });
  });

  it("rejects unknown template, paper, and label codes", async () => {
    await expectCode(adminDb.update(clinics).set({ rxTemplate: "fancy" }).where(eq(clinics.tenantId, A)), "23514", "clinics_rx_template_check");
    await expectCode(adminDb.update(clinics).set({ rxPaperSize: "Letter" }).where(eq(clinics.tenantId, A)), "23514", "clinics_rx_paper_size_check");
    await expectCode(adminDb.update(clinics).set({ rxLabels: "fr" }).where(eq(clinics.tenantId, A)), "23514", "clinics_rx_labels_check");
  });

  it("only points at the clinic's own assets (composite foreign keys)", async () => {
    const mine = await insertAsset(A, "own-logo");
    const theirs = await insertAsset(B, "their-logo");
    await adminDb.update(clinics).set({ logoAssetId: mine }).where(eq(clinics.tenantId, A));
    await expectCode(adminDb.update(clinics).set({ logoAssetId: theirs }).where(eq(clinics.tenantId, A)), "23503", "clinics_logo_asset_fk");
    await expectCode(adminDb.update(doctors).set({ signatureAssetId: theirs }).where(eq(doctors.tenantId, A)), "23503", "doctors_signature_asset_fk");
  });

  it("accepts the doctor's own signature, and offboarding still removes everything that references it", async () => {
    const [t] = await adminDb.insert(tenants).values({ name: "PrintC", slug: `print-c-${stamp}` }).returning();
    try {
      await adminDb.insert(clinics).values({ tenantId: t.id, name: "Print Clinic C" });
      await adminDb.insert(doctors).values({ tenantId: t.id });
      const logo = await insertAsset(t.id, "c-logo");
      const [sig] = await adminDb
        .insert(clinicAssets)
        .values(assetValues(t.id, "c-sig", { kind: "signature" }))
        .returning({ id: clinicAssets.id });
      await adminDb.update(clinics).set({ logoAssetId: logo }).where(eq(clinics.tenantId, t.id));
      await adminDb.update(doctors).set({ signatureAssetId: sig.id }).where(eq(doctors.tenantId, t.id));
      const rxId = await prescriptionIn(t.id, "finalized");
      await adminDb.insert(prescriptionOutputs).values(outputValues(t.id, rxId));
      const [doctor] = await adminDb.select().from(doctors).where(eq(doctors.tenantId, t.id));
      expect(doctor.signatureAssetId).toBe(sig.id);
    } finally {
      await adminDb.delete(tenants).where(eq(tenants.id, t.id));
    }
    expect(await adminDb.select().from(clinicAssets).where(eq(clinicAssets.tenantId, t.id))).toHaveLength(0);
    expect(await adminDb.select().from(doctors).where(eq(doctors.tenantId, t.id))).toHaveLength(0);
    expect(await adminDb.select().from(prescriptionOutputs).where(eq(prescriptionOutputs.tenantId, t.id))).toHaveLength(0);
  });

  it("stores the sign-up name as the doctor's printed name", async () => {
    const phone = `9${String(Date.now()).slice(-9)}`;
    const email = `print-${stamp}@example.com`;
    const created = await createClinicAccount({
      clinicName: "Print Signup Clinic",
      doctorName: "Dr. Print Signup",
      email,
      phone,
      password: "ClinicPad!2026",
    });
    if (!created.ok) throw new Error(created.error);
    try {
      const [doctor] = await adminDb.select().from(doctors).where(eq(doctors.userId, created.userId));
      expect(doctor.displayName).toBe("Dr. Print Signup");
    } finally {
      await adminDb.delete(tenants).where(eq(tenants.id, created.tenantId));
      await adminDb.delete(users).where(eq(users.id, created.userId));
    }
  });
});

describe("prescriptions.render_snapshot", () => {
  it("can be written while the prescription is a draft", async () => {
    const id = await prescriptionIn(A, "draft");
    await adminDb.update(prescriptions).set({ renderSnapshot: { v: 1 } }).where(eq(prescriptions.id, id));
    const [row] = await adminDb.select().from(prescriptions).where(eq(prescriptions.id, id));
    expect(row.renderSnapshot).toEqual({ v: 1 });
  });

  it("is frozen with the rest of a finalized prescription, and the amended flip still works", async () => {
    const id = await prescriptionIn(A, "finalized");
    await expectCode(adminDb.update(prescriptions).set({ renderSnapshot: { v: 1, marker: "tampered" } }).where(eq(prescriptions.id, id)), "23000");
    await adminDb.update(prescriptions).set({ status: "amended" }).where(eq(prescriptions.id, id));
    const [row] = await adminDb.select().from(prescriptions).where(eq(prescriptions.id, id));
    expect(row.renderSnapshot).toEqual({ v: 1, marker: "frozen" });
  });

  it("is frozen for the application role as well", async () => {
    const id = await prescriptionIn(A, "finalized");
    await expectCode(
      withTenant(A, (tx) => tx.update(prescriptions).set({ renderSnapshot: { v: 1, marker: "tampered" } }).where(eq(prescriptions.id, id))),
      "23000",
    );
    const [row] = await adminDb.select().from(prescriptions).where(eq(prescriptions.id, id));
    expect(row.renderSnapshot).toEqual({ v: 1, marker: "frozen" });
  });
});

describe("prescription_outputs", () => {
  it("records outputs of finalized prescriptions and is append-only for the application role", async () => {
    const id = await prescriptionIn(A, "finalized");
    await withTenant(A, (tx) => tx.insert(prescriptionOutputs).values(outputValues(A, id)));
    expect(await withTenant(A, (tx) => tx.select().from(prescriptionOutputs).where(eq(prescriptionOutputs.prescriptionId, id)))).toHaveLength(1);
    expect(await withTenant(B, (tx) => tx.select().from(prescriptionOutputs))).toHaveLength(0);

    await expectCode(withTenant(A, (tx) => tx.update(prescriptionOutputs).set({ kind: "pdf_download" })), "42501");
    await expectCode(withTenant(A, (tx) => tx.delete(prescriptionOutputs)), "42501");
  });

  it("is immutable on the admin connection too, while the tenant exists", async () => {
    const id = await prescriptionIn(A, "finalized");
    const [out] = await adminDb.insert(prescriptionOutputs).values(outputValues(A, id)).returning();
    await expectCode(adminDb.update(prescriptionOutputs).set({ kind: "pdf_download" }).where(eq(prescriptionOutputs.id, out.id)), "23000");
    await expectCode(adminDb.delete(prescriptionOutputs).where(eq(prescriptionOutputs.id, out.id)), "23000");
  });

  it("accepts amended (superseded) prescriptions but refuses any other status", async () => {
    const amended = await prescriptionIn(A, "finalized");
    await adminDb.update(prescriptions).set({ status: "amended" }).where(eq(prescriptions.id, amended));
    await adminDb.insert(prescriptionOutputs).values(outputValues(A, amended));

    // status is free text, so a draft moved to an arbitrary status must still be refused.
    const odd = await prescriptionIn(A, "draft");
    await adminDb.update(prescriptions).set({ status: "void" }).where(eq(prescriptions.id, odd));
    await expectCode(adminDb.insert(prescriptionOutputs).values(outputValues(A, odd)), "23000");
  });

  it("refuses outputs for drafts, even on the admin connection", async () => {
    const id = await prescriptionIn(A, "draft");
    await expectCode(adminDb.insert(prescriptionOutputs).values(outputValues(A, id)), "23000");
  });

  it("refuses an output that points at another clinic's prescription", async () => {
    const theirs = await prescriptionIn(B, "finalized");
    await expectCode(adminDb.insert(prescriptionOutputs).values(outputValues(A, theirs)), "23503");
    await expectCode(withTenant(A, (tx) => tx.insert(prescriptionOutputs).values(outputValues(A, theirs))), "23503");
  });

  it.each([
    ["an unknown kind", { kind: "fax" }, "rx_outputs_kind_check"],
    ["an unknown paper size", { paperSize: "Letter" }, "rx_outputs_paper_size_check"],
    ["a zero page count", { pageCount: 0 }, "rx_outputs_page_count_check"],
    ["a malformed hash", { htmlSha256: "xyz" }, "rx_outputs_sha256_check"],
    ["an unknown template key", { templateKey: "fancy" }, "rx_outputs_template_key_check"],
  ])("rejects %s", async (_label, overrides, constraint) => {
    const id = await prescriptionIn(A, "finalized");
    await expectCode(adminDb.insert(prescriptionOutputs).values(outputValues(A, id, overrides)), "23514", constraint);
  });
});

describe("foreign keys", () => {
  it("are composite same-tenant keys with the intended delete rules", async () => {
    const rows = await adminDb.execute<{ conname: string; on_delete: string; cols: string[] }>(sql`
      select c.conname::text as conname,
             case c.confdeltype when 'a' then 'NO ACTION' when 'c' then 'CASCADE' else c.confdeltype::text end as on_delete,
             (select array_agg(a.attname::text order by k.ord)
                from unnest(c.conkey) with ordinality k(attnum, ord)
                join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum) as cols
        from pg_constraint c
       where c.connamespace = 'public'::regnamespace
         and c.conname in ('clinics_logo_asset_fk', 'doctors_signature_asset_fk', 'rx_outputs_prescription_fk')
       order by c.conname`);
    expect([...rows]).toEqual([
      { conname: "clinics_logo_asset_fk", on_delete: "NO ACTION", cols: ["tenant_id", "logo_asset_id"] },
      { conname: "doctors_signature_asset_fk", on_delete: "NO ACTION", cols: ["tenant_id", "signature_asset_id"] },
      { conname: "rx_outputs_prescription_fk", on_delete: "CASCADE", cols: ["tenant_id", "prescription_id"] },
    ]);
  });
});
