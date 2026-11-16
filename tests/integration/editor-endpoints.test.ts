// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/auth/session", () => ({ getSessionContext: vi.fn(), requireSession: vi.fn() }));
vi.mock("@/auth", () => ({ auth: vi.fn() }));
// Wrapped so single tests can force a service to throw; they behave as the real services otherwise.
vi.mock("@/server/services/prescriptions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/services/prescriptions")>();
  return { ...actual, saveDraft: vi.fn(actual.saveDraft), finalizePrescription: vi.fn(actual.finalizePrescription) };
});
vi.mock("@/server/services/catalogue", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/services/catalogue")>();
  return { ...actual, searchMedicines: vi.fn(actual.searchMedicines) };
});

import { auth } from "@/auth";
import { getSessionContext } from "@/server/auth/session";
import { GET } from "@/app/api/catalogue/search/route";
import { autosaveDraftAction, finalizeDraftAction } from "@/server/actions/drafts";
import { addClinicMedicineAction, removeFavouriteAction, saveFavouriteAction } from "@/server/actions/catalogue";
import { searchMedicines } from "@/server/services/catalogue";
import { createPatient } from "@/server/services/patients";
import { finalizePrescription, getPrescription, saveDraft, startPrescription } from "@/server/services/prescriptions";
import { createTestTenant, type TestTenant } from "../helpers/tenant";

const session = vi.mocked(getSessionContext);
const authMock = vi.mocked(auth) as unknown as { mockReset: () => void; mockResolvedValue: (v: unknown) => void };
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
  authMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
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

const REVISION_ROLES = ["reception", "nurse", "accountant", "pharmacist"] as const;
const BAD_REVISIONS: [string, unknown][] = [
  ["missing", undefined],
  ["null", null],
  ["negative", -1],
  ["fractional", 1.5],
  ["NaN", Number.NaN],
  ["infinite", Number.POSITIVE_INFINITY],
  ["a string", "1"],
];

async function seededDraft(): Promise<string> {
  session.mockResolvedValue(A.as("doctor"));
  const id = await newDraft();
  expect(await autosaveDraftAction(id, { advice: "kept", items: [{ drugName: "Kept" }] }, 0)).toMatchObject({
    ok: true,
    revision: 1,
  });
  return id;
}

async function expectUntouched(id: string): Promise<void> {
  const rx = await getPrescription(A.as("doctor"), id);
  expect(rx.ok && rx.value).toMatchObject({ status: "draft", revision: 1, visit: { advice: "kept" } });
}

describe("baseRevision is validated at the action boundary", () => {
  it.each(BAD_REVISIONS)("autosave rejects a %s revision and writes nothing", async (_label, bad) => {
    const id = await seededDraft();
    vi.mocked(saveDraft).mockClear();
    expect(await autosaveDraftAction(id, { advice: "overwritten" }, bad as number)).toMatchObject({
      ok: false,
      code: "invalid",
      field: "baseRevision",
    });
    expect(saveDraft).not.toHaveBeenCalled();
    await expectUntouched(id);
  });

  it.each(BAD_REVISIONS)("finalize rejects a %s revision and neither saves nor finalizes", async (_label, bad) => {
    const id = await seededDraft();
    vi.mocked(saveDraft).mockClear();
    expect(
      await finalizeDraftAction(id, { advice: "overwritten", items: [{ drugName: "X" }] }, bad as number),
    ).toMatchObject({ ok: false, code: "invalid", field: "baseRevision" });
    expect(saveDraft).not.toHaveBeenCalled();
    await expectUntouched(id);
  });

  it("still accepts a valid revision and reports a stale one as a conflict", async () => {
    const id = await seededDraft();
    expect(await autosaveDraftAction(id, { advice: "kept" }, 1)).toMatchObject({ ok: true, revision: 2 });
    expect(await autosaveDraftAction(id, { advice: "late" }, 1)).toMatchObject({
      ok: false,
      code: "conflict",
      currentRevision: 2,
    });
  });
});

describe("unexpected failures become typed responses", () => {
  const INTERNAL_MESSAGE = "Something went wrong. Your changes are kept; trying again.";

  it("autosave survives a throwing service and a throwing session lookup", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const id = await seededDraft();
    vi.mocked(saveDraft).mockRejectedValueOnce(new Error("secret row value"));
    const failed = await autosaveDraftAction(id, { advice: "x" }, 1);
    expect(failed).toEqual({ ok: false, code: "internal", message: INTERNAL_MESSAGE });
    expect(JSON.stringify(failed)).not.toContain("secret");

    session.mockRejectedValueOnce(new Error("auth down"));
    expect(await autosaveDraftAction(id, { advice: "x" }, 1)).toEqual({
      ok: false,
      code: "internal",
      message: INTERNAL_MESSAGE,
    });
  });

  it("finalize reports the saved revision when finalizing itself throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const id = await seededDraft();
    vi.mocked(finalizePrescription).mockRejectedValueOnce(new Error("boom"));
    const res = await finalizeDraftAction(id, { advice: "kept", items: [{ drugName: "Kept" }] }, 1);
    expect(res).toMatchObject({ ok: false, code: "internal", message: INTERNAL_MESSAGE, revision: 2 });
    expect(res.ok === false && typeof res.savedAt).toBe("string");
  });

  it("finalize survives a throwing save without revision details", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const id = await seededDraft();
    vi.mocked(saveDraft).mockRejectedValueOnce(new Error("boom"));
    expect(await finalizeDraftAction(id, { advice: "x" }, 1)).toEqual({
      ok: false,
      code: "internal",
      message: INTERNAL_MESSAGE,
    });
  });

  it("catalogue actions survive a throwing session lookup", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    session.mockRejectedValue(new Error("auth down"));
    for (const result of [
      await saveFavouriteAction({ drugName: "X" }),
      await removeFavouriteAction("x"),
      await addClinicMedicineAction({ name: "Xyz" }),
    ]) {
      expect(result).toMatchObject({ ok: false, code: "internal" });
    }
  });

  it("the search route answers 500 with a no-store header and no internals", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    session.mockResolvedValue(A.as("doctor"));
    vi.mocked(searchMedicines).mockRejectedValueOnce(new Error("secret row value"));
    const res = await search("kind=medicine&q=x");
    expect(res.status).toBe(500);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(await res.json()).toEqual({ error: "internal" });

    session.mockRejectedValueOnce(new Error("auth down"));
    expect((await search("q=x")).status).toBe(500);
  });
});

describe("search route access and hostile input", () => {
  it.each([
    ["reception", 403],
    ["accountant", 403],
    ["nurse", 200],
    ["pharmacist", 200],
    ["owner", 200],
  ])("kind=medicine for %s answers %i", async (role, status) => {
    session.mockResolvedValue(A.as(role));
    const res = await search("kind=medicine&q=dolo");
    expect(res.status).toBe(status);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("answers 403 on term suggestions for reception, and 403 before 400 for a bad kind", async () => {
    session.mockResolvedValue(A.as("reception"));
    expect((await search("kind=complaint&q=fever")).status).toBe(403);
    expect((await search("kind=spell&q=x")).status).toBe(403);
    session.mockResolvedValue(A.as("accountant"));
    expect((await search("kind=spell&q=x")).status).toBe(403);
  });

  it.each([
    ["a NUL character", "dolo\u0000650"],
    ["10 kB of text", "a".repeat(10 * 1024)],
    ["a percent sign", "100%"],
    ["an underscore and backslash", "a_b\\c"],
    ["Devanagari", "\u092A\u0948\u0930\u093E\u0938\u093F\u091F\u092E\u0949\u0932"],
  ])("never answers 500 for q containing %s", async (_label, q) => {
    session.mockResolvedValue(A.as("doctor"));
    for (const kind of ["medicine", "complaint"]) {
      const res = await search(`kind=${kind}&q=${encodeURIComponent(q)}`);
      expect(res.status).toBe(200);
    }
  });

  it("takes the first value of repeated params and still never answers 500", async () => {
    session.mockResolvedValue(A.as("doctor"));
    expect((await search("kind=medicine&kind=spell&q=a&q=b")).status).toBe(200);
    expect((await search("kind=spell&kind=medicine&q=a&q=b")).status).toBe(400);
  });
});

describe("action role matrix and malformed ids", () => {
  it.each(REVISION_ROLES)("%s cannot autosave or finalize, and nothing is written", async (role) => {
    const id = await seededDraft();
    session.mockResolvedValue(A.as(role));
    expect(await autosaveDraftAction(id, { advice: "x" }, 1)).toMatchObject({ ok: false, code: "forbidden" });
    expect(await finalizeDraftAction(id, { advice: "x", items: [{ drugName: "X" }] }, 1)).toMatchObject({
      ok: false,
      code: "forbidden",
    });
    await expectUntouched(id);
  });

  it.each(REVISION_ROLES)("%s cannot use the favourite or clinic medicine actions", async (role) => {
    session.mockResolvedValue(A.as(role));
    expect(await saveFavouriteAction({ drugName: "X" })).toMatchObject({ ok: false, code: "forbidden" });
    expect(await removeFavouriteAction("x")).toMatchObject({ ok: false, code: "forbidden" });
    expect(await addClinicMedicineAction({ name: `Role${stamp}` })).toMatchObject({ ok: false, code: "forbidden" });
  });

  it("answers not_found for malformed prescription and favourite ids", async () => {
    session.mockResolvedValue(A.as("doctor"));
    for (const id of ["", "not-a-uuid", "1; drop table prescriptions", "00000000-0000-0000-0000-000000000000"]) {
      expect(await autosaveDraftAction(id, { advice: "x" }, 0)).toMatchObject({ ok: false, code: "not_found" });
      expect(await finalizeDraftAction(id, { advice: "x" }, 0)).toMatchObject({ ok: false, code: "not_found" });
    }
    expect(await removeFavouriteAction("not-a-uuid")).toMatchObject({ ok: false, code: "not_found" });
  });
});

describe("getSessionContext", () => {
  async function real(): Promise<() => Promise<unknown>> {
    const actual = await vi.importActual<typeof import("@/server/auth/session")>("@/server/auth/session");
    return actual.getSessionContext;
  }

  it("returns the session user, tenant and role", async () => {
    authMock.mockResolvedValue({ user: { id: "u1", tenantId: "t1", role: "doctor" } });
    expect(await (await real())()).toEqual({ userId: "u1", tenantId: "t1", role: "doctor" });
  });

  it.each([
    ["no session", null],
    ["no user id", { user: { tenantId: "t1", role: "doctor" } }],
    ["no tenant", { user: { id: "u1", role: "doctor" } }],
    ["no role", { user: { id: "u1", tenantId: "t1" } }],
  ])("returns null (and never redirects) with %s", async (_label, value) => {
    authMock.mockResolvedValue(value);
    expect(await (await real())()).toBeNull();
  });
});
