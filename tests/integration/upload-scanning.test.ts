// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { adminDb } from "@/server/db/admin";
import { auditEvents, clinicAssets } from "@/server/db/schema";
import { setClinicLogo, setDoctorSignature } from "@/server/services/pad-settings";
import { SCAN_MESSAGES } from "@/server/scanning/scanner";
import { createFakeScanner, resetFakeScanner } from "../helpers/fake-scanner";
import { makePng } from "../helpers/images";
import { createTestTenant, type TestTenant } from "../helpers/tenant";

let A: TestTenant;
const scanner = createFakeScanner();

beforeAll(async () => {
  A = await createTestTenant("upload-scan");
});
afterAll(async () => {
  await A.cleanup();
});
beforeEach(() => resetFakeScanner(scanner));

const rejectedEvents = async () =>
  (await adminDb.select().from(auditEvents).where(and(eq(auditEvents.tenantId, A.tenantId), eq(auditEvents.action, "upload.rejected")))).length;
const assetsOf = () => adminDb.select({ id: clinicAssets.id }).from(clinicAssets).where(eq(clinicAssets.tenantId, A.tenantId));

describe("logo and signature uploads are scanned before anything is stored", () => {
  it("stores a clean logo and scans it exactly once", async () => {
    const result = await setClinicLogo(A.as("owner"), { bytes: makePng(120, 60, [1, 2, 3]) }, { scanner });
    expect(result.ok).toBe(true);
    expect(scanner.calls).toBe(1);
  });

  it("refuses an infected signature, stores nothing, and audits the signature name", async () => {
    scanner.next = { status: "infected", engine: "fake-scanner 1.0", signature: "Win.Test.EICAR_HDB-1" };
    const before = (await assetsOf()).length;
    const result = await setDoctorSignature(A.as("doctor"), { bytes: makePng(200, 80, [9, 9, 9]) }, { scanner });
    expect(result).toEqual({ ok: false, code: "invalid", message: SCAN_MESSAGES.infected, field: "image" });
    expect((await assetsOf()).length).toBe(before);
    const [event] = await adminDb
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.tenantId, A.tenantId), eq(auditEvents.action, "upload.rejected")));
    expect(event.after).toMatchObject({ kind: "signature", reasonCode: "infected", signature: "Win.Test.EICAR_HDB-1" });
  });

  it("refuses when the scanner is unavailable, stores nothing, and does not audit", async () => {
    scanner.next = { status: "unavailable", reason: "timeout" };
    const before = (await assetsOf()).length;
    const eventsBefore = await rejectedEvents();
    const result = await setClinicLogo(A.as("owner"), { bytes: makePng(121, 60, [4, 5, 6]) }, { scanner });
    expect(result).toMatchObject({ ok: false, code: "unavailable", message: SCAN_MESSAGES.unavailable, field: "image" });
    expect((await assetsOf()).length).toBe(before);
    expect(await rejectedEvents()).toBe(eventsBefore);
  });

  it("does not scan a file that is not an image at all", async () => {
    const result = await setClinicLogo(A.as("owner"), { bytes: new TextEncoder().encode("<svg onload=alert(1)>") }, { scanner });
    expect(result).toMatchObject({ ok: false, code: "invalid", field: "image" });
    expect(scanner.calls).toBe(0);
  });

  it("records the scanner that cleared a logo in its audit event", async () => {
    const result = await setClinicLogo(A.as("owner"), { bytes: makePng(123, 60, [3, 3, 3]) }, { scanner });
    expect(result.ok).toBe(true);
    const events = await adminDb.select().from(auditEvents).where(and(eq(auditEvents.tenantId, A.tenantId), eq(auditEvents.action, "clinic.logo_set")));
    expect(events.at(-1)?.after).toMatchObject({ scanEngine: "fake-scanner 1.0" });
  });

  it("removing a logo needs no scan", async () => {
    const result = await setClinicLogo(A.as("owner"), null, { scanner });
    expect(result.ok).toBe(true);
    expect(scanner.calls).toBe(0);
  });
});
