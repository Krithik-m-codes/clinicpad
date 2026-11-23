// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { adminDb } from "@/server/db/admin";
import { pgErrorInfo } from "@/server/db/errors";
import { clinics } from "@/server/db/schema";
import { renderPrescription } from "@/lib/rx-render/render";
import { GALLERY_TEMPLATES, PAD_TEMPLATES } from "@/lib/rx-render/types";
import { TEMPLATE_DEFINITIONS } from "@/lib/rx-render/templates";
import { getClinicPad, updateClinicPad } from "@/server/services/pad-settings";
import { loadRxDocument } from "@/server/services/rx-documents";
import { finalized, newPatient } from "../helpers/rx-flow";
import { createTestTenant, type TestTenant } from "../helpers/tenant";

let A: TestTenant;
const pad = (rxTemplate: string) => ({ name: "Gallery Clinic", rxTemplate, rxPaperSize: "A4", rxLabels: "en" });

beforeAll(async () => {
  A = await createTestTenant("gallery");
});
afterAll(async () => {
  await A.cleanup();
});

describe("gallery pads through the clinic pad settings", () => {
  it.each([...PAD_TEMPLATES])("saves %s and reads it back", async (key) => {
    expect((await updateClinicPad(A.as("owner"), pad(key))).ok).toBe(true);
    expect(await getClinicPad(A.as("owner"))).toMatchObject({ ok: true, value: { rxTemplate: key } });
  });

  it("refuses an unknown pad with a field error, and the database CHECK refuses it too", async () => {
    expect(await updateClinicPad(A.as("owner"), pad("cardiology"))).toMatchObject({ ok: false, field: "rxTemplate" });
    const error = await adminDb
      .update(clinics)
      .set({ rxTemplate: "cardiology" })
      .where(eq(clinics.tenantId, A.tenantId))
      .then(() => null, (e: unknown) => e);
    expect(pgErrorInfo(error)).toMatchObject({ code: "23514", constraint: "clinics_rx_template_check" });
  });
});

describe("a prescription finalized on a gallery pad", () => {
  it.each([...GALLERY_TEMPLATES])("freezes %s as a v1 snapshot and reprints it after the clinic changes pad", async (key) => {
    expect((await updateClinicPad(A.as("owner"), pad(key))).ok).toBe(true);
    const patientId = await newPatient(A.as("owner"), `Gallery ${key}`);
    const id = await finalized(A.as("owner"), patientId);

    expect((await updateClinicPad(A.as("owner"), pad("general"))).ok).toBe(true);
    const loaded = await loadRxDocument(A.as("owner"), id);
    if (!loaded.ok) throw new Error(loaded.message);
    expect(loaded.value.document.snapshot.v).toBe(1);
    expect(loaded.value.document.snapshot.layout.template).toEqual({ kind: "builtin", key });
    const printed = renderPrescription(loaded.value.document, { logo: null, signature: null, fontCss: "" }).html;
    expect(printed).toContain(`tpl-${key}`);
    expect(printed).toContain(`--accent:${TEMPLATE_DEFINITIONS[key].accent}`);
  });
});
