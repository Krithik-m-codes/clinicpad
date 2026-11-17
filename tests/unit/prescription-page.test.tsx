import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const mocks = vi.hoisted(() => ({ getPrescription: vi.fn(), notFound: vi.fn() }));

vi.mock("next/navigation", () => ({
  notFound: () => {
    mocks.notFound();
    throw new Error("NEXT_NOT_FOUND");
  },
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock("@/server/auth/session", () => ({
  requireSession: async () => ({ tenantId: "t", userId: "u", role: "doctor" }),
}));
vi.mock("@/server/services/prescriptions", () => ({ getPrescription: mocks.getPrescription }));
vi.mock("@/server/services/catalogue", () => ({ listFavourites: vi.fn() }));
vi.mock("@/server/actions/prescriptions", () => ({ amendAction: vi.fn(), repeatAction: vi.fn() }));
vi.mock("@/components/rx/clinical-editor", () => ({ ClinicalEditor: () => null }));

import PrescriptionPage from "@/app/(app)/prescriptions/[id]/page";

const ID = "00000000-0000-4000-8000-000000000001";
const params = Promise.resolve({ id: ID });

beforeEach(() => vi.clearAllMocks());

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
