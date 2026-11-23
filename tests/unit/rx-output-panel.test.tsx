import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@/components/rx/output-actions", () => ({ OutputActions: () => null }));

import { RxOutputPanel, type RxOutputPanelProps } from "@/components/rx/rx-output-panel";

const props = (over: Partial<RxOutputPanelProps> = {}): RxOutputPanelProps => ({
  prescriptionId: "p1", isDraft: false, canEdit: false, fileName: "rx.pdf", supersededBy: null, replaces: null, missingProfile: [], printedWithout: [], outputs: null, timeZone: "Asia/Kolkata", ...over,
});

describe("RxOutputPanel unprinted sections", () => {
  it("warns when the pinned pad leaves off sections that have content", () => {
    render(<RxOutputPanel {...props({ unprintedSections: ["advice", "followUp"] })} />);
    const note = screen.getByText(/does not print/i);
    expect(note).toHaveTextContent("Advice, Follow-up");
    expect(note).toHaveTextContent(/printed copy or the PDF/);
  });
  it("shows nothing when every section with content prints", () => {
    render(<RxOutputPanel {...props({ unprintedSections: [] })} />);
    expect(screen.queryByText(/does not print/i)).toBeNull();
  });
});
