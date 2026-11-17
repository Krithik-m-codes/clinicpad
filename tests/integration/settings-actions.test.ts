// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

vi.mock("@/server/auth/session", () => ({ requireSession: vi.fn(), getSessionContext: vi.fn() }));
vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { requireSession } from "@/server/auth/session";
import { adminDb } from "@/server/db/admin";
import { clinicAssets, clinics } from "@/server/db/schema";
import {
  removeLogoAction,
  removeSignatureAction,
  saveClinicPadAction,
  saveDoctorProfileAction,
  uploadLogoAction,
  uploadSignatureAction,
} from "@/server/actions/settings";
import { makePng } from "../helpers/images";
import { createTestTenant, type TestTenant } from "../helpers/tenant";

const session = vi.mocked(requireSession);
let A: TestTenant;

function form(values: Record<string, string | File>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.append(key, value);
  return data;
}

const assetCount = async () => (await adminDb.select().from(clinicAssets).where(eq(clinicAssets.tenantId, A.tenantId))).length;

beforeAll(async () => {
  A = await createTestTenant("padact");
});

afterAll(async () => {
  await A.cleanup();
});

beforeEach(() => {
  session.mockReset();
  session.mockResolvedValue(A.as("owner"));
});

describe("settings actions", () => {
  it("saves the clinic pad from a form", async () => {
    const state = await saveClinicPadAction({}, form({ name: "Action Clinic", city: "Nashik", rxTemplate: "derma", rxPaperSize: "A4", rxLabels: "hi" }));
    expect(state).toEqual({ saved: true });
    const [row] = await adminDb.select().from(clinics).where(eq(clinics.tenantId, A.tenantId));
    expect(row).toMatchObject({ name: "Action Clinic", city: "Nashik", rxTemplate: "derma", rxLabels: "hi" });
  });

  it("returns the field error and the typed values on invalid input", async () => {
    const state = await saveClinicPadAction({}, form({ name: "Action Clinic", email: "nope", rxTemplate: "general", rxPaperSize: "A4", rxLabels: "en" }));
    expect(state).toMatchObject({ field: "email", values: { email: "nope" } });
  });

  it("refuses a clinic pad without a name", async () => {
    expect(await saveClinicPadAction({}, form({ name: "  ", city: "Nashik" }))).toMatchObject({ field: "name", values: { name: "  " } });
    const [row] = await adminDb.select().from(clinics).where(eq(clinics.tenantId, A.tenantId));
    expect(row.name).toBe("Action Clinic");
  });

  it("refuses a doctor profile save for reception", async () => {
    session.mockResolvedValue(A.as("reception"));
    expect(await saveDoctorProfileAction({}, form({ displayName: "Dr. X" }))).toMatchObject({ error: expect.any(String) });
  });

  it("saves the doctor profile for a doctor", async () => {
    session.mockResolvedValue(A.as("doctor"));
    expect(await saveDoctorProfileAction({}, form({ displayName: "Dr. Action", registrationNo: "REG-1" }))).toEqual({ saved: true });
  });

  it("uploads and removes a logo", async () => {
    const file = new File([new Uint8Array(makePng(80, 40))], "logo.png", { type: "image/png" });
    expect(await uploadLogoAction({}, form({ image: file }))).toEqual({ saved: true });
    expect(await removeLogoAction({})).toEqual({ saved: true });
  });

  it("uploads and removes a signature as a doctor, and refuses it for reception", async () => {
    const file = new File([new Uint8Array(makePng(80, 40, [5, 6, 7]))], "sig.png", { type: "image/png" });
    session.mockResolvedValue(A.as("doctor"));
    expect(await uploadSignatureAction({}, form({ image: file }))).toEqual({ saved: true });
    expect(await removeSignatureAction({})).toEqual({ saved: true });
    session.mockResolvedValue(A.as("reception"));
    expect(await uploadSignatureAction({}, form({ image: file }))).toMatchObject({ error: expect.any(String) });
    expect(await removeSignatureAction({})).toMatchObject({ error: expect.any(String) });
  });

  it("does not store the client's file name or declared type", async () => {
    const file = new File([new Uint8Array(makePng(81, 41, [8, 8, 8]))], "Dr Private Name.png", { type: "image/png" });
    expect(await uploadLogoAction({}, form({ image: file }))).toEqual({ saved: true });
    const rows = await adminDb.select().from(clinicAssets).where(eq(clinicAssets.tenantId, A.tenantId));
    expect(JSON.stringify(rows.map((r) => ({ kind: r.kind, mime: r.mime, sha256: r.sha256, byteSize: r.byteSize })))).not.toContain("Private");
  });

  it("rejects an oversized file before reading it into the database", async () => {
    const before = await assetCount();
    const big = new File([new Uint8Array(600 * 1024)], "big.png", { type: "image/png" });
    expect(await uploadLogoAction({}, form({ image: big }))).toEqual({ error: "The image is larger than 512 KB.", field: "image" });
    expect(await uploadLogoAction({}, form({}))).toEqual({ error: "Choose a PNG or JPEG image first.", field: "image" });
    expect(await uploadLogoAction({}, form({ image: "not a file" }))).toEqual({ error: "Choose a PNG or JPEG image first.", field: "image" });
    expect(await assetCount()).toBe(before);
  });

  it("rejects a non-image that claims to be a PNG", async () => {
    const fake = new File(["<svg onload=alert(1)>"], "evil.png", { type: "image/png" });
    expect(await uploadLogoAction({}, form({ image: fake }))).toEqual({ error: "Upload a PNG or JPEG image.", field: "image" });
  });

  it("answers with a typed error instead of throwing when the service fails", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      session.mockResolvedValue({ tenantId: "not-a-uuid", userId: "x", role: "owner" });
      expect(await saveClinicPadAction({}, form({ name: "Boom Clinic" }))).toEqual({ error: "Something went wrong. Please try again." });
    } finally {
      spy.mockRestore();
    }
  });
});
