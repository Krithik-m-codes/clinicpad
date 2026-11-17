import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  getPrescription: vi.fn(),
  getVersionLinks: vi.fn(),
  loadRxDocument: vi.fn(),
  listPrescriptionOutputs: vi.fn(),
  getPadReadiness: vi.fn(),
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
vi.mock("@/server/services/rx-documents", () => ({
  getVersionLinks: mocks.getVersionLinks,
  loadRxDocument: mocks.loadRxDocument,
}));
vi.mock("@/server/services/rx-output", () => ({ listPrescriptionOutputs: mocks.listPrescriptionOutputs }));
vi.mock("@/server/services/pad-settings", () => ({ getPadReadiness: mocks.getPadReadiness }));
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
  mocks.getVersionLinks.mockResolvedValue({ ok: true, value: { supersededBy: null, replaces: null } });
  mocks.loadRxDocument.mockResolvedValue({ ok: false, code: "not_found", message: "x" });
  mocks.listPrescriptionOutputs.mockResolvedValue({ ok: true, value: { count: 0, lastAt: null } });
  mocks.getPadReadiness.mockResolvedValue({ ok: true, value: { missing: [] } });
});

function finalizedView(status: "finalized" | "amended") {
  return {
    ok: true,
    value: {
      id: ID,
      status,
      version: 1,
      revision: 3,
      rxNo: 7,
      amendmentReason: null,
      parentPrescriptionId: null,
      finalizedAt: new Date("2026-11-12T05:30:00.000Z"),
      patient: { id: "p1", name: "Live Name", patientNo: 1, allergies: ["Penicillin"] },
      visit: {},
      items: [],
    },
  };
}

/** The parts of a loadRxDocument result the page reads. */
function printable(overrides: { patientName?: string; registrationNo?: string | null } = {}) {
  return {
    ok: true,
    value: {
      prescriptionId: ID,
      logo: null,
      signature: null,
      document: {
        snapshotSource: "finalize",
        snapshot: {
          patient: { name: overrides.patientName ?? "Live Name" },
          doctor: { name: "Dr Shah", registrationNo: overrides.registrationNo === undefined ? "MMC-1" : overrides.registrationNo },
          clinic: { timezone: "Asia/Kolkata" },
        },
      },
    },
  };
}

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

describe("prescription page print panel and notices", () => {
  it("offers print and download on a finalized version and shows the name it was finalized with", async () => {
    mocks.getPrescription.mockResolvedValue(finalizedView("finalized"));
    mocks.loadRxDocument.mockResolvedValue(printable({ patientName: "Frozen Name" }));
    render(await PrescriptionPage({ params }));
    expect(screen.getByRole("link", { name: "Frozen Name" })).toHaveAttribute("href", "/patients/p1");
    expect(screen.getByText(/now recorded as Live Name/)).toBeInTheDocument();
    // The allergy banner is a live safety prompt, not part of the frozen record.
    expect(screen.getByText("Allergies: Penicillin")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Print" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download PDF" })).toBeInTheDocument();
    expect(screen.getByText("Not printed or downloaded yet.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /repeat as new prescription/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /start amendment/i })).toBeInTheDocument();
    expect(mocks.loadRxDocument).toHaveBeenCalledWith(mocks.session, ID, { withAssets: false });
  });

  it("marks a superseded version, keeps it printable, and offers no repeat or amendment", async () => {
    mocks.getPrescription.mockResolvedValue(finalizedView("amended"));
    mocks.loadRxDocument.mockResolvedValue(printable());
    mocks.getVersionLinks.mockResolvedValue({ ok: true, value: { supersededBy: { id: "v2-id", version: 2 }, replaces: null } });
    render(await PrescriptionPage({ params }));
    expect(screen.getByText(/Superseded by/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "version 2" })).toHaveAttribute("href", "/prescriptions/v2-id");
    expect(screen.getByRole("button", { name: "Print" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /repeat as new prescription/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /start amendment/i })).toBeNull();
  });

  it("says what a finalized copy prints without", async () => {
    mocks.getPrescription.mockResolvedValue(finalizedView("finalized"));
    mocks.loadRxDocument.mockResolvedValue(printable({ registrationNo: null }));
    render(await PrescriptionPage({ params }));
    expect(screen.getByText(/This copy prints without a registration number/)).toBeInTheDocument();
  });

  it.each(["reception", "nurse", "pharmacist"])("marks a draft as not a prescription for %s and offers only a preview", async (role) => {
    mocks.session.role = role;
    mocks.getPrescription.mockResolvedValue(draftView(null));
    render(await PrescriptionPage({ params }));
    expect(screen.getByText(/This draft is not a prescription yet/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Preview pad" })).toHaveAttribute("href", `/prescriptions/${ID}/document?purpose=preview`);
    expect(screen.queryByRole("button", { name: "Print" })).toBeNull();
    expect(mocks.getPadReadiness).not.toHaveBeenCalled();
  });

  it("warns a prescriber before finalizing: an incomplete profile, or no doctor profile at all", async () => {
    mocks.getPrescription.mockResolvedValue(draftView(null));
    mocks.getPadReadiness.mockResolvedValue({ ok: true, value: { missing: ["registrationNo"] } });
    const first = render(await PrescriptionPage({ params }));
    expect(screen.getByText(/missing your registration number/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Complete your profile" })).toHaveAttribute("href", "/settings/profile");
    expect(screen.queryByText(/This draft is not a prescription yet/)).toBeNull();
    first.unmount();

    mocks.session.role = "owner";
    mocks.getPadReadiness.mockResolvedValue({ ok: true, value: { missing: ["noDoctorProfile"] } });
    render(await PrescriptionPage({ params }));
    expect(screen.getByText(/no doctor profile in this clinic/)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Complete your profile" })).toBeNull();
  });
});

