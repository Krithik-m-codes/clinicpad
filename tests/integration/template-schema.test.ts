import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { adminDb } from "@/server/db/admin";
import { withTenant } from "@/server/db/tenant";
import { pgErrorInfo } from "@/server/db/errors";
import {
  clinics,
  doctors,
  patients,
  prescriptionItems,
  prescriptionOutputs,
  prescriptions,
  templateFiles,
  templates,
  templateVersions,
  tenants,
  visits,
} from "@/server/db/schema";
import { createTestTenant, type TestTenant } from "../helpers/tenant";
import { fileValues, insertBackgroundFile, insertTemplate, MINIMAL_OVERLAY_DEFINITION } from "../helpers/templates";

let A: TestTenant;
let B: TestTenant;
let nextRxNo = 9300;

async function expectCode(promise: Promise<unknown>, code: string) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error, "expected the statement to be rejected").not.toBeNull();
  expect(pgErrorInfo(error).code).toBe(code);
}

async function doctorOf(tenantId: string): Promise<string> {
  const [row] = await adminDb.select({ id: doctors.id }).from(doctors).where(eq(doctors.tenantId, tenantId)).limit(1);
  return row.id;
}

/** A draft prescription with one item, ready to be finalized by the test. */
async function draftRx(tenantId: string): Promise<{ rxId: string; visitId: string }> {
  const [patient] = await adminDb.insert(patients).values({ tenantId, name: "Template Schema Patient" }).returning();
  const [visit] = await adminDb.insert(visits).values({ tenantId, patientId: patient.id, status: "draft" }).returning();
  const [rx] = await adminDb.insert(prescriptions).values({ tenantId, visitId: visit.id, status: "draft" }).returning();
  await adminDb.insert(prescriptionItems).values({ tenantId, prescriptionId: rx.id, drugName: "Paracetamol" });
  return { rxId: rx.id, visitId: visit.id };
}

/** Finalizes the way finalizePrescription does: template_version_id and the snapshot in the same UPDATE. */
function finalizeWith(rxId: string, templateVersionId: string | null, snapshotVersionId: string | null, snapshotOverride?: unknown) {
  nextRxNo += 1;
  const template = snapshotVersionId
    ? { kind: "overlay", templateVersionId: snapshotVersionId, contentSha256: "c".repeat(64) }
    : { kind: "builtin", key: "general" };
  const renderSnapshot = snapshotOverride === undefined ? { v: snapshotVersionId ? 2 : 1, layout: { template } } : snapshotOverride;
  return adminDb
    .update(prescriptions)
    .set({ status: "finalized", rxNo: nextRxNo, finalizedAt: new Date(), templateVersionId, renderSnapshot })
    .where(eq(prescriptions.id, rxId));
}

/** The same finalize under the application role (what the services run as); the triggers must hold there too. */
function finalizeAsApp(tenantId: string, rxId: string, templateVersionId: string | null, renderSnapshot: unknown) {
  nextRxNo += 1;
  return withTenant(tenantId, (tx) =>
    tx.update(prescriptions).set({ status: "finalized", rxNo: nextRxNo, finalizedAt: new Date(), templateVersionId, renderSnapshot }).where(eq(prescriptions.id, rxId)),
  );
}

beforeAll(async () => {
  A = await createTestTenant("tpl-schema-a");
  B = await createTestTenant("tpl-schema-b");
});

afterAll(async () => {
  await A.cleanup();
  await B.cleanup();
});

describe("template_files", () => {
  it("is tenant-isolated, readable and insertable by the app role, never updatable", async () => {
    await withTenant(A.tenantId, (tx) => tx.insert(templateFiles).values(fileValues(A.tenantId, "app-insert")));
    expect((await withTenant(A.tenantId, (tx) => tx.select({ id: templateFiles.id }).from(templateFiles))).length).toBeGreaterThan(0);
    expect(await withTenant(B.tenantId, (tx) => tx.select({ id: templateFiles.id }).from(templateFiles))).toHaveLength(0);
    await expectCode(withTenant(A.tenantId, (tx) => tx.update(templateFiles).set({ scanEngine: "changed" })), "42501");
    await expectCode(withTenant(B.tenantId, (tx) => tx.insert(templateFiles).values(fileValues(A.tenantId, "leak"))), "42501");
  });

  const big = Buffer.alloc(1024 * 1024 + 1, 1);
  it.each([
    ["a DOCX kind (2B)", { kind: "docx" }],
    ["an SVG", { mime: "image/svg+xml" }],
    ["a size that does not match the bytes", { byteSize: 3 }],
    ["more than 1 MB (override 3/16b)", { bytes: big, byteSize: big.length, sha256: createHash("sha256").update(big).digest("hex") }],
    ["a long side under 1,100 px", { width: 700, height: 990 }],
    ["a long side over 3,600 px", { width: 2600, height: 3700 }],
    ["US Letter proportions", { width: 850, height: 1100 }],
    ["a square photo", { width: 1200, height: 1200 }],
    ["a hash that is not of the bytes", { sha256: "a".repeat(64) }],
    ["a malformed hash", { sha256: "not-a-hash" }],
    ["no scan engine", { scanEngine: "" }],
    ["object storage (not built)", { storage: "s3" }],
  ])("rejects %s (23514)", async (label, overrides) => {
    await expectCode(adminDb.insert(templateFiles).values(fileValues(A.tenantId, `bad-${label}`, overrides)), "23514");
  });

  it("de-duplicates identical bytes per tenant and kind (23505), but not across tenants", async () => {
    await insertBackgroundFile(A.tenantId, "dup");
    await expectCode(adminDb.insert(templateFiles).values(fileValues(A.tenantId, "dup")), "23505");
    await insertBackgroundFile(B.tenantId, "dup");
  });

  it("forces created_at to now() on insert, so a client cannot backdate a file past the one-day delete rule", async () => {
    const [row] = await adminDb.insert(templateFiles).values(fileValues(A.tenantId, "backdated", { createdAt: new Date(Date.now() - 10 * 86_400_000) })).returning();
    expect(Math.abs(row.createdAt.getTime() - Date.now())).toBeLessThan(60_000);
    await expectCode(withTenant(A.tenantId, (tx) => tx.delete(templateFiles).where(eq(templateFiles.id, row.id))), "23000");
  });

  it("is immutable even on the admin connection (23000)", async () => {
    const id = await insertBackgroundFile(A.tenantId, "frozen");
    await expectCode(adminDb.update(templateFiles).set({ scanEngine: "changed" }).where(eq(templateFiles.id, id)), "23000");
  });

  it("refuses deleting a file younger than a day (23000) or one a version uses (23503)", async () => {
    const young = await insertBackgroundFile(A.tenantId, "young");
    await expectCode(withTenant(A.tenantId, (tx) => tx.delete(templateFiles).where(eq(templateFiles.id, young))), "23000");
    const old = await insertBackgroundFile(A.tenantId, "old-used", { createdAt: new Date(Date.now() - 3 * 86_400_000) });
    await insertTemplate(A.tenantId, { fileId: old });
    await expectCode(withTenant(A.tenantId, (tx) => tx.delete(templateFiles).where(eq(templateFiles.id, old))), "23503");
  });

  it("lets the app role delete an old unused file (garbage collection)", async () => {
    const old = await insertBackgroundFile(A.tenantId, "old-unused", { createdAt: new Date(Date.now() - 3 * 86_400_000) });
    await withTenant(A.tenantId, (tx) => tx.delete(templateFiles).where(eq(templateFiles.id, old)));
    expect(await adminDb.select().from(templateFiles).where(eq(templateFiles.id, old))).toHaveLength(0);
  });
});

describe("templates", () => {
  it.each([
    ["the Phase 0 html kind", { kind: "html" }],
    ["an unknown status", { status: "draft" }],
    ["an empty name", { name: "" }],
  ])("rejects %s (23514)", async (_label, overrides) => {
    await expectCode(adminDb.insert(templates).values({ tenantId: A.tenantId, name: "Pad", kind: "overlay", ...overrides }), "23514");
  });

  it("no longer carries a binding: it lives on the version (override 2)", async () => {
    const rows = await adminDb.execute<{ column_name: string }>(sql`
      select column_name::text from information_schema.columns where table_name = 'templates' and column_name in ('identity', 'bound_doctor_id')`);
    expect(rows).toHaveLength(0);
  });

  it("points current_version_id only at one of its own published versions (23000)", async () => {
    const draft = await insertTemplate(A.tenantId);
    await expectCode(adminDb.update(templates).set({ currentVersionId: draft.versionId }).where(eq(templates.id, draft.templateId)), "23000");
    const other = await insertTemplate(A.tenantId, { publish: true });
    await expectCode(adminDb.update(templates).set({ currentVersionId: other.versionId }).where(eq(templates.id, draft.templateId)), "23000");
  });
});

describe("template_versions", () => {
  it("is born as a draft (23000 for a published insert)", async () => {
    const { templateId, fileId } = await insertTemplate(A.tenantId);
    await expectCode(
      adminDb.insert(templateVersions).values({
        tenantId: A.tenantId,
        templateId,
        version: 2,
        fileId,
        definition: MINIMAL_OVERLAY_DEFINITION,
        paperSize: "A4",
        labels: "en",
        state: "published",
        contentSha256: "c".repeat(64),
        publishedAt: new Date(),
      }),
      "23000",
    );
  });

  it("rejects an unknown state (23000 from the BEFORE trigger, ahead of the CHECK)", async () => {
    const { templateId, fileId } = await insertTemplate(A.tenantId);
    await expectCode(
      adminDb.insert(templateVersions).values({ tenantId: A.tenantId, templateId, version: 6, fileId, definition: MINIMAL_OVERLAY_DEFINITION, paperSize: "A4", labels: "en", state: "archived" }),
      "23000",
    );
  });

  it("carries the binding: bound needs a doctor, dynamic names none, confirmation only for bound (23514)", async () => {
    const { templateId, fileId } = await insertTemplate(A.tenantId);
    const doctorId = await doctorOf(A.tenantId);
    const base = { tenantId: A.tenantId, templateId, fileId, definition: MINIMAL_OVERLAY_DEFINITION, paperSize: "A4", labels: "en" };
    await expectCode(adminDb.insert(templateVersions).values({ ...base, version: 11, identity: "bound" }), "23514");
    await expectCode(adminDb.insert(templateVersions).values({ ...base, version: 12, identity: "dynamic", boundDoctorId: doctorId }), "23514");
    await expectCode(adminDb.insert(templateVersions).values({ ...base, version: 13, identity: "mixed" }), "23514");
    await expectCode(adminDb.insert(templateVersions).values({ ...base, version: 14, identity: "dynamic", boundConfirmed: true }), "23514");
    await adminDb.insert(templateVersions).values({ ...base, version: 15, identity: "bound", boundDoctorId: doctorId });
  });

  it("publishes a bound version only with its confirmation, and binds only to a doctor of the same clinic", async () => {
    const doctorId = await doctorOf(A.tenantId);
    const bound = await insertTemplate(A.tenantId, { label: "bound-draft" });
    await expectCode(
      adminDb.update(templateVersions).set({ identity: "bound", boundDoctorId: doctorId, state: "published", contentSha256: "c".repeat(64), publishedAt: new Date() }).where(eq(templateVersions.id, bound.versionId)),
      "23514",
    );
    const foreignDoctor = await doctorOf(B.tenantId);
    await expectCode(adminDb.update(templateVersions).set({ identity: "bound", boundDoctorId: foreignDoctor }).where(eq(templateVersions.id, bound.versionId)), "23503");
    const ok = await insertTemplate(A.tenantId, { publish: true, identity: "bound", boundDoctorId: doctorId });
    const [row] = await adminDb.select().from(templateVersions).where(eq(templateVersions.id, ok.versionId));
    expect(row).toMatchObject({ identity: "bound", boundDoctorId: doctorId, boundConfirmed: true });
    // Frozen with the version (C1): the binding cannot be rewritten once published.
    await expectCode(adminDb.update(templateVersions).set({ identity: "dynamic", boundDoctorId: null, boundConfirmed: false }).where(eq(templateVersions.id, ok.versionId)), "23000");
  });

  it("confirms a binding only at publish, and a published version records who published it (23514)", async () => {
    const doctorId = await doctorOf(A.tenantId);
    const { templateId, fileId } = await insertTemplate(A.tenantId);
    // A draft cannot already be "confirmed" (the confirmation is part of the publishing UPDATE).
    await expectCode(
      adminDb.insert(templateVersions).values({ tenantId: A.tenantId, templateId, fileId, definition: MINIMAL_OVERLAY_DEFINITION, paperSize: "A4", labels: "en", version: 21, identity: "bound", boundDoctorId: doctorId, boundConfirmed: true }),
      "23514",
    );
    // Publishing without published_by is refused; with it, accepted.
    const { versionId } = await insertTemplate(A.tenantId);
    const publish = { state: "published", contentSha256: "c".repeat(64), publishedAt: new Date() };
    await expectCode(adminDb.update(templateVersions).set(publish).where(eq(templateVersions.id, versionId)), "23514");
    await adminDb.update(templateVersions).set({ ...publish, publishedBy: randomUUID() }).where(eq(templateVersions.id, versionId));
  });

  it("refuses deleting a published version under the application role too (23000)", async () => {
    const { versionId } = await insertTemplate(A.tenantId, { publish: true });
    await expectCode(withTenant(A.tenantId, (tx) => tx.delete(templateVersions).where(eq(templateVersions.id, versionId))), "23000");
    expect(await adminDb.select().from(templateVersions).where(eq(templateVersions.id, versionId))).toHaveLength(1);
  });

  it("insertTemplate keeps the binding it was given on an unpublished draft", async () => {
    const doctorId = await doctorOf(A.tenantId);
    const { versionId } = await insertTemplate(A.tenantId, { identity: "bound", boundDoctorId: doctorId });
    const [row] = await adminDb.select().from(templateVersions).where(eq(templateVersions.id, versionId));
    expect(row).toMatchObject({ state: "draft", identity: "bound", boundDoctorId: doctorId, boundConfirmed: false });
  });

  it("lets the app role edit and delete a draft", async () => {
    const { versionId } = await insertTemplate(A.tenantId);
    await withTenant(A.tenantId, (tx) => tx.update(templateVersions).set({ labels: "hi", draftRevision: 1 }).where(eq(templateVersions.id, versionId)));
    await withTenant(A.tenantId, (tx) => tx.delete(templateVersions).where(eq(templateVersions.id, versionId)));
    expect(await adminDb.select().from(templateVersions).where(eq(templateVersions.id, versionId))).toHaveLength(0);
  });

  it("freezes a published version on every connection, and refuses deleting it or its template (23000)", async () => {
    const { templateId, versionId } = await insertTemplate(A.tenantId, { publish: true });
    await expectCode(withTenant(A.tenantId, (tx) => tx.update(templateVersions).set({ labels: "hi" }).where(eq(templateVersions.id, versionId))), "23000");
    await expectCode(adminDb.update(templateVersions).set({ definition: { v: 1 } }).where(eq(templateVersions.id, versionId)), "23000");
    await expectCode(adminDb.delete(templateVersions).where(eq(templateVersions.id, versionId)), "23000");
    await adminDb.update(templates).set({ currentVersionId: null }).where(eq(templates.id, templateId));
    await expectCode(adminDb.delete(templates).where(eq(templates.id, templateId)), "23000");
  });

  it.each([
    ["Letter paper", { paperSize: "Letter" }],
    ["an unknown label language", { labels: "fr" }],
    ["version 0", { version: 0 }],
    ["a definition that is not an object", { definition: [1, 2] }],
  ])("rejects %s (23514)", async (_label, overrides) => {
    const { templateId, fileId } = await insertTemplate(A.tenantId);
    await expectCode(
      adminDb.insert(templateVersions).values({ tenantId: A.tenantId, templateId, version: 5, fileId, definition: MINIMAL_OVERLAY_DEFINITION, paperSize: "A4", labels: "en", ...overrides }),
      "23514",
    );
  });

  it("rejects publishing without a content hash (23514)", async () => {
    const { versionId } = await insertTemplate(A.tenantId);
    await expectCode(adminDb.update(templateVersions).set({ state: "published", publishedAt: new Date() }).where(eq(templateVersions.id, versionId)), "23514");
  });

  it("uses only files of its own clinic (23503)", async () => {
    const { templateId } = await insertTemplate(A.tenantId);
    const foreignFile = await insertBackgroundFile(B.tenantId, "foreign-file");
    await expectCode(
      adminDb.insert(templateVersions).values({ tenantId: A.tenantId, templateId, version: 7, fileId: foreignFile, definition: MINIMAL_OVERLAY_DEFINITION, paperSize: "A4", labels: "en" }),
      "23503",
    );
  });
});

describe("assignment columns", () => {
  it("assign only the clinic's own templates (23503), and an assigned template cannot be deleted (23503)", async () => {
    const own = await insertTemplate(A.tenantId);
    const foreign = await insertTemplate(B.tenantId);
    await expectCode(adminDb.update(clinics).set({ customTemplateId: foreign.templateId }).where(eq(clinics.tenantId, A.tenantId)), "23503");
    await expectCode(adminDb.update(doctors).set({ templateId: foreign.templateId }).where(eq(doctors.tenantId, A.tenantId)), "23503");
    await adminDb.update(doctors).set({ templateId: own.templateId }).where(eq(doctors.tenantId, A.tenantId));
    await expectCode(adminDb.delete(templates).where(eq(templates.id, own.templateId)), "23503");
    await adminDb.update(doctors).set({ templateId: null }).where(eq(doctors.tenantId, A.tenantId));
  });
});

describe("prescriptions and outputs name the template version", () => {
  it("refuses an overlay snapshot without the template_version_id column (23000)", async () => {
    const one = await insertTemplate(A.tenantId, { publish: true });
    const { rxId } = await draftRx(A.tenantId);
    await expectCode(finalizeWith(rxId, null, one.versionId), "23000");
  });

  it("finalizes only on a published version (23000)", async () => {
    const { versionId } = await insertTemplate(A.tenantId);
    const { rxId } = await draftRx(A.tenantId);
    await expectCode(finalizeWith(rxId, versionId, versionId), "23000");
  });

  it("under the application role: refuses a snapshot that names a version without kind overlay, in either column state (23000)", async () => {
    const one = await insertTemplate(A.tenantId, { publish: true });
    const { rxId } = await draftRx(A.tenantId);
    const naming = { v: 2, layout: { template: { templateVersionId: one.versionId, contentSha256: "c".repeat(64) } } };
    await expectCode(finalizeAsApp(A.tenantId, rxId, one.versionId, naming), "23000");
    await expectCode(finalizeAsApp(A.tenantId, rxId, null, naming), "23000");
    await expectCode(finalizeAsApp(A.tenantId, rxId, null, { v: 2, layout: { template: { kind: "overlay", templateVersionId: one.versionId, contentSha256: "c".repeat(64) } } }), "23000");
    await expectCode(finalizeAsApp(A.tenantId, rxId, one.versionId, { v: 2, layout: { template: { kind: "builtin", templateVersionId: one.versionId } } }), "23000");
  });

  it("refuses a template version without any snapshot (23514: the old 'snapshot is null' escape is gone)", async () => {
    const one = await insertTemplate(A.tenantId, { publish: true });
    const { rxId } = await draftRx(A.tenantId);
    await expectCode(finalizeWith(rxId, one.versionId, null, null), "23514");
  });

  it("keeps the column and the frozen snapshot in agreement (23514)", async () => {
    const one = await insertTemplate(A.tenantId, { publish: true });
    const two = await insertTemplate(A.tenantId, { publish: true });
    const { rxId } = await draftRx(A.tenantId);
    await expectCode(finalizeWith(rxId, one.versionId, two.versionId), "23514");
    await expectCode(finalizeWith(rxId, one.versionId, null), "23514");
    await finalizeWith(rxId, one.versionId, one.versionId);
  });

  it("logs outputs that name exactly the prescription's template version", async () => {
    const one = await insertTemplate(A.tenantId, { publish: true });
    const two = await insertTemplate(A.tenantId, { publish: true });
    const { rxId } = await draftRx(A.tenantId);
    await finalizeWith(rxId, one.versionId, one.versionId);
    const base = { tenantId: A.tenantId, prescriptionId: rxId, kind: "browser_print", paperSize: "A4", htmlSha256: "a".repeat(64), engine: "browser" };
    // The trigger (BEFORE) answers first: an output names exactly its prescription's version, in both directions.
    await expectCode(adminDb.insert(prescriptionOutputs).values({ ...base, templateKey: "overlay" }), "23000");
    await expectCode(adminDb.insert(prescriptionOutputs).values({ ...base, templateKey: "general" }), "23000");
    await expectCode(adminDb.insert(prescriptionOutputs).values({ ...base, templateKey: "general", templateVersionId: one.versionId }), "23514");
    await expectCode(adminDb.insert(prescriptionOutputs).values({ ...base, templateKey: "overlay", templateVersionId: one.versionId, engine: "gpu" }), "23514");
    await expectCode(adminDb.insert(prescriptionOutputs).values({ ...base, templateKey: "overlay", templateVersionId: two.versionId }), "23000");
    await adminDb.insert(prescriptionOutputs).values({ ...base, templateKey: "overlay", templateVersionId: one.versionId });
  });

  it("under the application role: a built-in prescription takes only built-in outputs, an overlay one only its own version (23000)", async () => {
    const one = await insertTemplate(A.tenantId, { publish: true });
    const two = await insertTemplate(A.tenantId, { publish: true });
    const overlayRx = (await draftRx(A.tenantId)).rxId;
    const builtinRx = (await draftRx(A.tenantId)).rxId;
    await finalizeWith(overlayRx, one.versionId, one.versionId);
    await finalizeWith(builtinRx, null, null);
    const base = { tenantId: A.tenantId, kind: "browser_print", paperSize: "A4", htmlSha256: "a".repeat(64), engine: "browser" };
    const insert = (values: typeof prescriptionOutputs.$inferInsert) => withTenant(A.tenantId, (tx) => tx.insert(prescriptionOutputs).values(values));
    await expectCode(insert({ ...base, prescriptionId: builtinRx, templateKey: "overlay", templateVersionId: one.versionId }), "23000");
    await expectCode(insert({ ...base, prescriptionId: overlayRx, templateKey: "general" }), "23000");
    await expectCode(insert({ ...base, prescriptionId: overlayRx, templateKey: "overlay", templateVersionId: two.versionId }), "23000");
    await insert({ ...base, prescriptionId: builtinRx, templateKey: "general" });
    await insert({ ...base, prescriptionId: overlayRx, templateKey: "overlay", templateVersionId: one.versionId });
  });
});

describe("offboarding", () => {
  it("still deletes a tenant with published versions, files, assignments and outputs", async () => {
    const C = await createTestTenant("tpl-schema-off");
    try {
    const { templateId, versionId, fileId } = await insertTemplate(C.tenantId, { publish: true });
    await adminDb.update(clinics).set({ customTemplateId: templateId }).where(eq(clinics.tenantId, C.tenantId));
    await adminDb.update(doctors).set({ templateId }).where(eq(doctors.tenantId, C.tenantId));
    const { rxId } = await draftRx(C.tenantId);
    await finalizeWith(rxId, versionId, versionId);
    await adminDb.insert(prescriptionOutputs).values({
      tenantId: C.tenantId,
      prescriptionId: rxId,
      kind: "browser_print",
      paperSize: "A4",
      htmlSha256: "a".repeat(64),
      engine: "browser",
      templateKey: "overlay",
      templateVersionId: versionId,
    });
    await C.cleanup();
    for (const [table, id] of [[templateFiles, fileId], [templateVersions, versionId], [templates, templateId]] as const) {
      expect(await adminDb.select({ id: table.id }).from(table).where(eq(table.id, id))).toHaveLength(0);
    }
    expect(await adminDb.select({ id: tenants.id }).from(tenants).where(eq(tenants.id, C.tenantId))).toHaveLength(0);
    } finally {
      await C.cleanup().catch(() => undefined);
    }
  });
});

it("the migrations created every guard this file relies on", async () => {
  const rows = await adminDb.execute<{ tgname: string }>(sql`
    select tgname::text from pg_trigger where not tgisinternal and tgname in
      ('template_files_rules', 'templates_rules', 'template_versions_rules', 'prescriptions_template_version') order by 1`);
  expect(rows.map((r) => r.tgname)).toEqual(["prescriptions_template_version", "template_files_rules", "template_versions_rules", "templates_rules"]);
});
