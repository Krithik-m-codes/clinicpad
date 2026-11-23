import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { adminDb } from "@/server/db/admin";
import { clinics } from "@/server/db/schema";
import { createPatient, updatePatient } from "@/server/services/patients";
import { getClinicTimeZone } from "@/server/services/clinic";
import { DOB_FUTURE_MESSAGE } from "@/server/validation/patient";
import { createTestTenant, type TestTenant } from "../helpers/tenant";

let IST: TestTenant;
let NYC: TestTenant;
// 00:30 on 17 November in India; still 16 November in New York.
const NOW = new Date("2026-11-16T19:00:00.000Z");

beforeAll(async () => {
  IST = await createTestTenant("dates-ist");
  NYC = await createTestTenant("dates-nyc");
  await adminDb.update(clinics).set({ timezone: "America/New_York" }).where(eq(clinics.tenantId, NYC.tenantId));
});

afterAll(async () => {
  await IST.cleanup();
  await NYC.cleanup();
});

afterEach(() => {
  vi.useRealTimers();
});

/** Only Date is faked: timers and I/O keep running, so database calls behave normally. */
function at(now: Date) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
}

describe("date of birth on the clinic's calendar", () => {
  it("registers a baby born today, 00:30 IST, in an Indian clinic", async () => {
    at(NOW);
    const created = await createPatient(IST.as("reception"), { name: "Baby Rao", dob: "2026-11-17" });
    expect(created).toMatchObject({ ok: true });
  });

  it("refuses the same date in a New York clinic, where it is still 16 November", async () => {
    at(NOW);
    const created = await createPatient(NYC.as("reception"), { name: "Baby Doe", dob: "2026-11-17" });
    expect(created).toEqual({ ok: false, code: "invalid", message: DOB_FUTURE_MESSAGE, field: "dob" });
  });

  it("refuses tomorrow everywhere, before any database work (the structural UTC+14 bound)", async () => {
    at(NOW);
    const created = await createPatient(IST.as("reception"), { name: "Baby Later", dob: "2026-11-18" });
    expect(created).toMatchObject({ ok: false, code: "invalid", field: "dob" });
  });

  it("applies the same rule when a patient is edited", async () => {
    at(NOW);
    const created = await createPatient(NYC.as("reception"), { name: "Edit Doe" });
    if (!created.ok) throw new Error(created.message);
    const updated = await updatePatient(NYC.as("reception"), created.value.id, { name: "Edit Doe", dob: "2026-11-17" });
    expect(updated).toEqual({ ok: false, code: "invalid", message: DOB_FUTURE_MESSAGE, field: "dob" });
    const fine = await updatePatient(NYC.as("reception"), created.value.id, { name: "Edit Doe", dob: "2026-11-16" });
    expect(fine).toMatchObject({ ok: true });
  });
});

describe("getClinicTimeZone", () => {
  it("returns the clinic's zone, or Asia/Kolkata when the stored zone is damaged", async () => {
    expect(await getClinicTimeZone(NYC.as("nurse"))).toBe("America/New_York");
    await adminDb.update(clinics).set({ timezone: "Not/AZone" }).where(eq(clinics.tenantId, IST.tenantId));
    try {
      expect(await getClinicTimeZone(IST.as("nurse"))).toBe("Asia/Kolkata");
    } finally {
      await adminDb.update(clinics).set({ timezone: "Asia/Kolkata" }).where(eq(clinics.tenantId, IST.tenantId));
    }
  });
});
