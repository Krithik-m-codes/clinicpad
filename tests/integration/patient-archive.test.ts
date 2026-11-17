import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { adminDb } from "@/server/db/admin";
import { auditEvents } from "@/server/db/schema";
import { archivePatient, createPatient, getPatient, searchPatients, unarchivePatient } from "@/server/services/patients";
import { startPrescription } from "@/server/services/prescriptions";
import { createTestTenant, type TestTenant } from "../helpers/tenant";

let A: TestTenant;
let B: TestTenant;

async function patient(name: string): Promise<string> {
  const created = await createPatient(A.as("reception"), { name });
  if (!created.ok) throw new Error(created.message);
  return created.value.id;
}

beforeAll(async () => {
  A = await createTestTenant("archive-a");
  B = await createTestTenant("archive-b");
});

afterAll(async () => {
  await A.cleanup();
  await B.cleanup();
});

describe("archive and restore", () => {
  it("hides an archived patient from search and getPatient, except in the owner's archived view", async () => {
    const id = await patient("Archive Hidden");
    expect(await archivePatient(A.as("owner"), id)).toEqual({ ok: true, value: null });
    const active = await searchPatients(A.as("reception"), { q: "Archive Hidden" });
    expect(active.ok && active.value.map((p) => p.id)).toEqual([]);
    expect(await getPatient(A.as("doctor"), id)).toMatchObject({ ok: false, code: "not_found" });
    expect(await getPatient(A.as("doctor"), id, { includeArchived: true })).toMatchObject({ ok: false, code: "not_found" });
    const owner = await getPatient(A.as("owner"), id, { includeArchived: true });
    expect(owner.ok && owner.value.deletedAt).toBeInstanceOf(Date);
    const archived = await searchPatients(A.as("owner"), { q: "Archive Hidden", archived: true });
    expect(archived.ok && archived.value.map((p) => p.id)).toEqual([id]);
  });

  it("lists archived patients only for roles that may archive", async () => {
    for (const role of ["doctor", "reception", "nurse"]) {
      expect(await searchPatients(A.as(role), { archived: true })).toMatchObject({ ok: false, code: "forbidden" });
    }
  });

  it("lets only the owner archive or restore", async () => {
    const id = await patient("Archive Roles");
    for (const role of ["doctor", "reception", "nurse", "pharmacist", "accountant"]) {
      expect(await archivePatient(A.as(role), id)).toMatchObject({ ok: false, code: "forbidden" });
    }
    await archivePatient(A.as("owner"), id);
    for (const role of ["doctor", "reception", "nurse"]) {
      expect(await unarchivePatient(A.as(role), id)).toMatchObject({ ok: false, code: "forbidden" });
    }
  });

  it("restores a patient, audits both events with ids only, and allows new prescriptions again", async () => {
    const id = await patient("Archive Restore");
    await archivePatient(A.as("owner"), id);
    expect(await startPrescription(A.as("doctor"), { patientId: id })).toMatchObject({ ok: false, code: "not_found" });
    expect(await unarchivePatient(A.as("owner"), id)).toEqual({ ok: true, value: null });
    expect(await getPatient(A.as("doctor"), id)).toMatchObject({ ok: true });
    expect(await startPrescription(A.as("doctor"), { patientId: id })).toMatchObject({ ok: true });
    const events = await adminDb
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.tenantId, A.tenantId), eq(auditEvents.entityId, id)));
    const actions = events.map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(["patient.archived", "patient.unarchived"]));
    const restored = events.find((e) => e.action === "patient.unarchived");
    expect(JSON.stringify(restored)).not.toContain("Archive Restore");
  });

  it("answers not_found for restoring an active patient, a malformed id, or another clinic's patient", async () => {
    const id = await patient("Archive Active");
    expect(await unarchivePatient(A.as("owner"), id)).toMatchObject({ ok: false, code: "not_found" });
    expect(await unarchivePatient(A.as("owner"), "x")).toMatchObject({ ok: false, code: "not_found" });
    await archivePatient(A.as("owner"), id);
    expect(await unarchivePatient(B.as("owner"), id)).toMatchObject({ ok: false, code: "not_found" });
    expect(await archivePatient(A.as("owner"), id)).toMatchObject({ ok: false, code: "not_found" });
  });
});
