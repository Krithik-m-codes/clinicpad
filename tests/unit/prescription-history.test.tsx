import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";

vi.mock("@/components/rx/output-actions", () => ({
  OutputActions: ({ fileName }: { fileName: string }) => <div data-testid="output-actions">{fileName}</div>,
}));
vi.mock("@/components/rx/repeat-form", () => ({ RepeatForm: () => <div data-testid="repeat" /> }));
vi.mock("@/server/actions/prescriptions", () => ({ repeatAction: vi.fn() }));

import { PrescriptionHistory, historyHref } from "@/components/patients/prescription-history";
import type { HistoryPage, HistoryRow } from "@/server/services/patient-history";

const row = (overrides: Partial<HistoryRow>): HistoryRow => ({
  id: "00000000-0000-4000-8000-000000000001",
  rxNo: 7,
  version: 1,
  status: "finalized",
  chiefComplaint: "Fever",
  diagnosis: ["Viral fever"],
  doctorName: "Dr Shah",
  createdAt: new Date("2026-11-16T18:00:00.000Z"),
  finalizedAt: new Date("2026-11-16T19:00:00.000Z"),
  templateVersionId: null,
  ...overrides,
});

const page = (overrides: Partial<HistoryPage> = {}): HistoryPage => ({
  rows: [],
  hasMore: false,
  filters: { offset: 0 },
  doctors: [{ id: "00000000-0000-4000-8000-0000000000d1", name: "Dr Shah" }],
  timeZone: "Asia/Kolkata",
  ...overrides,
});

describe("PrescriptionHistory", () => {
  it("says there are none yet, or that none match the filters with a way back", () => {
    const first = render(<PrescriptionHistory patientId="p1" page={page()} canRepeat />);
    expect(screen.getByText("No prescriptions yet.")).toBeInTheDocument();
    first.unmount();
    render(<PrescriptionHistory patientId="p1" page={page({ filters: { status: "amended", offset: 0 } })} canRepeat />);
    expect(screen.getByText("No prescriptions match these filters.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Clear filters" })).toHaveAttribute("href", "/patients/p1");
  });

  it("offers print and download for signed versions, and repeat only for the current version to prescribers", () => {
    const rows = [
      row({ id: "00000000-0000-4000-8000-00000000000a", status: "finalized", version: 2 }),
      row({ id: "00000000-0000-4000-8000-00000000000b", status: "amended" }),
      row({ id: "00000000-0000-4000-8000-00000000000c", status: "draft", rxNo: null, finalizedAt: null }),
    ];
    const view = render(<PrescriptionHistory patientId="p1" page={page({ rows })} canRepeat />);
    const items = view.getAllByRole("listitem");
    expect(within(items[0]).getByRole("link", { name: "Rx #7 v2" })).toHaveAttribute("href", `/prescriptions/${rows[0].id}`);
    expect(within(items[0]).getByTestId("output-actions")).toHaveTextContent("Rx-7-v2.pdf");
    expect(within(items[0]).getByTestId("repeat")).toBeInTheDocument();
    expect(within(items[1]).getByText("Superseded")).toBeInTheDocument();
    expect(within(items[1]).queryByTestId("repeat")).toBeNull();
    expect(within(items[2]).getByRole("link", { name: "Draft" })).toBeInTheDocument();
    expect(within(items[2]).queryByTestId("output-actions")).toBeNull();
    view.unmount();
    render(<PrescriptionHistory patientId="p1" page={page({ rows: [rows[0]] })} canRepeat={false} />);
    expect(screen.queryByTestId("repeat")).toBeNull();
  });

  it("shows dates on the clinic's calendar", () => {
    render(<PrescriptionHistory patientId="p1" page={page({ rows: [row({})] })} canRepeat />);
    // 2026-11-16T19:00Z is 17 November in India.
    expect(screen.getByText("17 Nov 2026")).toBeInTheDocument();
  });

  it("keeps the filters in the pagination links and echoes them in the form", () => {
    const filters = { status: "finalized" as const, q: "fever", from: "2026-11-01", offset: 20 };
    render(<PrescriptionHistory patientId="p1" page={page({ rows: [row({})], hasMore: true, filters })} canRepeat />);
    expect(screen.getByRole("link", { name: "Next" })).toHaveAttribute("href", "/patients/p1?from=2026-11-01&status=finalized&q=fever&offset=40");
    expect(screen.getByRole("link", { name: "Previous" })).toHaveAttribute("href", "/patients/p1?from=2026-11-01&status=finalized&q=fever");
    expect(screen.getByLabelText("Diagnosis or complaint")).toHaveValue("fever");
    expect(screen.getByLabelText("Status")).toHaveValue("finalized");
  });

  it("builds hrefs with only the set filters", () => {
    expect(historyHref("p1", { offset: 0 }, 0)).toBe("/patients/p1");
    expect(historyHref("p1", { doctor: "d", q: "a&b", offset: 0 }, 20)).toBe("/patients/p1?doctor=d&q=a%26b&offset=20");
  });
});
