import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ discardDraft: vi.fn(), redirect: vi.fn() }));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    mocks.redirect(url);
    throw new Error("NEXT_REDIRECT");
  },
}));
vi.mock("@/server/auth/session", () => ({
  requireSession: async () => ({ tenantId: "t", userId: "u", role: "doctor" }),
}));
vi.mock("@/server/services/prescriptions", () => ({
  amendPrescription: vi.fn(),
  discardDraft: mocks.discardDraft,
  repeatPrescription: vi.fn(),
  startPrescription: vi.fn(),
}));

import { discardDraftAction } from "@/server/actions/prescriptions";

beforeEach(() => vi.clearAllMocks());

describe("discardDraftAction", () => {
  it("says the draft was changed or discarded elsewhere when it is not found", async () => {
    mocks.discardDraft.mockResolvedValue({ ok: false, code: "not_found", message: "Prescription not found." });
    expect(await discardDraftAction("id", {})).toEqual({ error: "This draft was changed or discarded elsewhere." });
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it("passes other refusals through unchanged", async () => {
    mocks.discardDraft.mockResolvedValue({ ok: false, code: "immutable", message: "This prescription cannot be discarded." });
    expect(await discardDraftAction("id", {})).toEqual({ error: "This prescription cannot be discarded." });
  });

  it("redirects to the patient, or to the parent after a withdrawn amendment", async () => {
    mocks.discardDraft.mockResolvedValueOnce({ ok: true, value: { patientId: "p1", parentPrescriptionId: null } });
    await expect(discardDraftAction("id", {})).rejects.toThrow("NEXT_REDIRECT");
    expect(mocks.redirect).toHaveBeenLastCalledWith("/patients/p1");

    mocks.discardDraft.mockResolvedValueOnce({ ok: true, value: { patientId: "p1", parentPrescriptionId: "rx0" } });
    await expect(discardDraftAction("id", {})).rejects.toThrow("NEXT_REDIRECT");
    expect(mocks.redirect).toHaveBeenLastCalledWith("/prescriptions/rx0");
  });
});
