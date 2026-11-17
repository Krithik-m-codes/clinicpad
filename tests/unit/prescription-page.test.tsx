import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  getPrescription: vi.fn(),
  notFound: vi.fn(),
  session: { tenantId: "t", userId: "u", role: "doctor" },
}));

vi.mock("next/navigation", () => ({
  notFound: () => {
    mocks.notFound();
    throw new Error("NEXT_NOT_FOUND");
  },
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock("@/server/auth/session", () => ({
  requireSession: async () => mocks.session,
}));
vi.mock("@/server/services/prescriptions", () => ({ getPrescription: mocks.getPrescription }));
vi.mock("@/server/services/catalogue", () => ({ listFavourites: vi.fn() }));
vi.mock("@/server/actions/prescriptions", () => ({
  amendAction: vi.fn(),
  repeatAction: vi.fn(),
  discardDraftAction: vi.fn(),
}));
vi.mock("@/components/rx/clinical-editor", () => ({ ClinicalEditor: () => <div>editor</div> }));
vi.mock("@/components/rx/prescription-view", () => ({ PrescriptionReadOnly: () => <div>read-only</div> }));
vi.mock("@/components/rx/discard-draft-form", () => ({
  DiscardDraftForm: ({ label }: { label: string }) => <button type="button">{label}</button>,
}));

import PrescriptionPage from "@/app/(app)/prescriptions/[id]/page";

const ID = "00000000-0000-4000-8000-000000000001";
const params = Promise.resolve({ id: ID });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.session.role = "doctor";
});

function draftView(parentPrescriptionId: string | null) {
  return {
    ok: true,
    value: {
      id: ID,
      status: "draft",
      version: parentPrescriptionId ? 2 : 1,
      revision: 0,
      rxNo: null,
      amendmentReason: null,
      parentPrescriptionId,
      patient: { id: "p1", name: "Pat", patientNo: 1, allergies: [] },
      visit: {},
      items: [],
    },
  };
}

describe("prescription page discard control", () => {
  it("offers Discard draft to a doctor and Withdraw amendment on an amendment draft", async () => {
    mocks.getPrescription.mockResolvedValue(draftView(null));
    const first = render(await PrescriptionPage({ params }));
    expect(screen.getByRole("button", { name: "Discard draft" })).toBeInTheDocument();
    first.unmount();

    mocks.getPrescription.mockResolvedValue(draftView("00000000-0000-4000-8000-000000000009"));
    render(await PrescriptionPage({ params }));
    expect(screen.getByRole("button", { name: "Withdraw amendment" })).toBeInTheDocument();
  });

  it.each(["reception", "nurse", "pharmacist", "accountant"])("shows %s no discard control and no editor", async (role) => {
    mocks.session.role = role;
    mocks.getPrescription.mockResolvedValue(draftView(null));
    render(await PrescriptionPage({ params }));
    expect(screen.queryByRole("button", { name: /discard|withdraw/i })).toBeNull();
    expect(screen.queryByText("editor")).toBeNull();
    expect(screen.getByText("read-only")).toBeInTheDocument();
  });
});

describe("prescription page failed reads", () => {
  it("shows a refresh state (full reload link) for a read conflict, not not-found", async () => {
    mocks.getPrescription.mockResolvedValue({ ok: false, code: "conflict", message: "busy" });
    render(await PrescriptionPage({ params }));
    expect(screen.getByText("This prescription changed while loading.")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: /refresh/i });
    expect(link).toHaveAttribute("href", `/prescriptions/${ID}`);
    expect(mocks.notFound).not.toHaveBeenCalled();
  });

  it.each(["not_found", "forbidden"])("maps %s to not-found", async (code) => {
    mocks.getPrescription.mockResolvedValue({ ok: false, code, message: "x" });
    await expect(PrescriptionPage({ params })).rejects.toThrow("NEXT_NOT_FOUND");
  });
});
