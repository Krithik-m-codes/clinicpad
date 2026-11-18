import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@/server/actions/templates", () => ({ archiveTemplateAction: vi.fn(), unarchiveTemplateAction: vi.fn() }));

import { TemplateList } from "@/components/templates/template-list";
import type { TemplateSummary } from "@/server/services/templates";

const summary = (over: Partial<TemplateSummary> = {}): TemplateSummary => ({
  id: "t1",
  name: "Main pad",
  status: "active",
  identity: "dynamic",
  boundDoctorId: null,
  current: { versionId: "v1", version: 2, publishedAt: new Date("2026-11-18T00:00:00Z") },
  draft: null,
  assignedToClinic: false,
  assignedDoctorIds: [],
  canWrite: true,
  ...over,
});

describe("TemplateList", () => {
  it("explains the empty state", () => {
    render(<TemplateList templates={[]} doctors={[]} canArchive />);
    expect(screen.getByText(/No pads yet/)).toBeInTheDocument();
  });

  it("shows status, use and the archive action only where it is allowed, and renders hostile names as text", () => {
    const hostile = '<img src=x onerror="alert(1)">';
    const { container, rerender } = render(
      <TemplateList templates={[summary({ name: hostile, assignedToClinic: true, assignedDoctorIds: ["d1"] }), summary({ id: "t2", name: "Old", status: "archived", current: null })]} doctors={[{ id: "d1", name: "Dr Rao" }]} canArchive />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText(hostile)).toBeInTheDocument();
    expect(screen.getByText("Published v2")).toBeInTheDocument();
    expect(screen.getByText("Used by the whole clinic, Dr Rao")).toBeInTheDocument();
    expect(screen.getByText("Archived")).toBeInTheDocument();
    const archive = screen.getByRole("button", { name: "Archive" });
    expect(archive).toBeDisabled();
    expect(screen.getByRole("button", { name: "Restore" })).toBeEnabled();
    rerender(<TemplateList templates={[summary()]} doctors={[]} canArchive={false} />);
    expect(screen.queryByRole("button", { name: "Archive" })).not.toBeInTheDocument();
    expect(screen.getByText("Not in use")).toBeInTheDocument();
  });
});
