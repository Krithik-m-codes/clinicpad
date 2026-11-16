// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/auth/session", () => ({ getSessionContext: vi.fn(), requireSession: vi.fn() }));

import { getSessionContext } from "@/server/auth/session";
import { GET } from "@/app/api/catalogue/search/route";
import { autosaveDraftAction, finalizeDraftAction } from "@/server/actions/drafts";
import { addClinicMedicineAction, removeFavouriteAction, saveFavouriteAction } from "@/server/actions/catalogue";
import { createPatient } from "@/server/services/patients";
import { getPrescription, startPrescription } from "@/server/services/prescriptions";
import { createTestTenant, type TestTenant } from "../helpers/tenant";

const session = vi.mocked(getSessionContext);
const stamp = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
let A: TestTenant;
let patientId = "";

beforeAll(async () => {
  A = await createTestTenant("endp");
  const p = await createPatient(A.as("reception"), { name: "Endpoint Patient" });
  if (!p.ok) throw new Error(p.message);
  patientId = p.value.id;
});

afterAll(async () => {
  await A.cleanup();
});

beforeEach(() => {
  session.mockReset();
});

const search = (query: string) => GET(new Request(`http://localhost/api/catalogue/search?${query}`));

async function newDraft(): Promise<string> {
  const r = await startPrescription(A.as("doctor"), { patientId });
  if (!r.ok) throw new Error(r.message);
  return r.value.prescriptionId;
}

describe("GET /api/catalogue/search", () => {
  it("answers 401 without a session", async () => {
    session.mockResolvedValue(null);
    const res = await search("q=dolo");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthenticated" });
  });

  it("answers 403 for roles without catalogue access", async () => {
    session.mockResolvedValue(A.as("reception"));
    expect((await search("q=dolo")).status).toBe(403);
  });

  it("returns medicines for a doctor and is never cached", async () => {
    session.mockResolvedValue(A.as("doctor"));
    const added = await addClinicMedicineAction({ name: `ROUTE${stamp} SYRUP` });
    expect(added.ok).toBe(true);

    const res = await search(`kind=medicine&q=${encodeURIComponent(`route${stamp}`)}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    const body = (await res.json()) as { medicines: { name: string; source: string }[] };
    expect(body.medicines).toEqual([expect.objectContaining({ name: `ROUTE${stamp} SYRUP`, source: "clinic" })]);
  });

  it("returns term suggestions, and rejects unknown kinds", async () => {
    session.mockResolvedValue(A.as("doctor"));
    const empty = await search("kind=complaint&q=");
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ terms: [] });
    expect((await search("kind=spell&q=x")).status).toBe(400);
  });
});

describe("autosaveDraftAction", () => {
  it("reports a signed-out user instead of redirecting", async () => {
    session.mockResolvedValue(null);
    expect(await autosaveDraftAction(await newDraft(), { advice: "x" }, 0)).toMatchObject({
      ok: false,
      code: "unauthenticated",
    });
  });

  it("saves with revisions and reports a stale revision with the current one", async () => {
    session.mockResolvedValue(A.as("doctor"));
    const id = await newDraft();
    const first = await autosaveDraftAction(id, { advice: "first" }, 0);
    expect(first).toMatchObject({ ok: true, revision: 1 });
    expect(first.ok && typeof first.savedAt).toBe("string");
    expect(await autosaveDraftAction(id, { advice: "stale" }, 0)).toEqual({
      ok: false,
      code: "conflict",
      message: "This draft was changed in another window or device.",
      currentRevision: 1,
    });
  });

  it("passes field errors through and refuses roles that cannot draft", async () => {
    session.mockResolvedValue(A.as("doctor"));
    const id = await newDraft();
    expect(await autosaveDraftAction(id, { vitals: { pulse: 999 } }, 0)).toMatchObject({
      ok: false,
      code: "invalid",
      field: "vitals",
    });
    session.mockResolvedValue(A.as("reception"));
    expect(await autosaveDraftAction(id, { advice: "x" }, 0)).toMatchObject({ ok: false, code: "forbidden" });
  });
});

describe("finalizeDraftAction", () => {
  it("saves the snapshot on screen and finalizes exactly that revision", async () => {
    session.mockResolvedValue(A.as("doctor"));
    const id = await newDraft();
    await autosaveDraftAction(id, { advice: "draft" }, 0);
    const done = await finalizeDraftAction(id, { advice: "final", items: [{ drugName: "Paracetamol" }] }, 1);
    expect(done).toMatchObject({ ok: true, rxNo: expect.any(Number) });
    const rx = await getPrescription(A.as("doctor"), id);
    expect(rx.ok && rx.value).toMatchObject({ status: "finalized", visit: { advice: "final" } });
  });

  it("returns the new revision when finalizing fails after the save", async () => {
    session.mockResolvedValue(A.as("doctor"));
    const id = await newDraft();
    expect(await finalizeDraftAction(id, { advice: "no medicines" }, 0)).toMatchObject({
      ok: false,
      code: "invalid",
      field: "items",
      revision: 1,
    });
  });

  it("refuses a stale snapshot without finalizing", async () => {
    session.mockResolvedValue(A.as("doctor"));
    const id = await newDraft();
    await autosaveDraftAction(id, { items: [{ drugName: "Newer" }] }, 0);
    expect(await finalizeDraftAction(id, { items: [{ drugName: "Older" }] }, 0)).toMatchObject({
      ok: false,
      code: "conflict",
      currentRevision: 1,
    });
    const rx = await getPrescription(A.as("doctor"), id);
    expect(rx.ok && rx.value.status).toBe("draft");
  });
});

describe("catalogue actions", () => {
  it("saves and removes a favourite for the signed-in prescriber", async () => {
    session.mockResolvedValue(A.as("doctor"));
    const saved = await saveFavouriteAction({ drugName: `FAV${stamp}`, doseNight: 1 });
    if (!saved.ok) throw new Error(saved.message);
    expect(saved.value).toMatchObject({ drugName: `FAV${stamp}`, doseNight: 1 });
    expect(await removeFavouriteAction(saved.value.id)).toEqual({ ok: true, value: null });
  });

  it("reports a signed-out user", async () => {
    session.mockResolvedValue(null);
    expect(await saveFavouriteAction({ drugName: "X" })).toMatchObject({ ok: false, code: "unauthenticated" });
    expect(await removeFavouriteAction("x")).toMatchObject({ ok: false, code: "unauthenticated" });
    expect(await addClinicMedicineAction({ name: "Xyz" })).toMatchObject({ ok: false, code: "unauthenticated" });
  });
});
