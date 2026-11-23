import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const list = vi.hoisted(() => vi.fn());
vi.mock("@/server/actions/templates", () => ({ listPreviewPrescriptionsAction: list }));

import { PreviewPanel } from "@/components/templates/preview-panel";

describe("PreviewPanel real-patient picker", () => {
  it("does not load patient names until the user asks for them", async () => {
    list.mockResolvedValueOnce({ prescriptions: [{ id: "rx1", label: "Asha Rao · Rx 7" }] });
    render(<PreviewPanel templateId="t1" versionId={null} canPreviewReal />);
    expect(list).not.toHaveBeenCalled();
    expect(screen.queryByText(/Asha Rao/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /with a real patient/i }));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole("option", { name: "Asha Rao · Rx 7" })).toBeInTheDocument();
  });

  it("offers nothing to a viewer who cannot read prescriptions", () => {
    render(<PreviewPanel templateId="t1" versionId={null} canPreviewReal={false} />);
    expect(screen.queryByRole("button", { name: /with a real patient/i })).toBeNull();
  });
});
