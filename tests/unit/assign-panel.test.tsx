import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
const assign = vi.hoisted(() => vi.fn());
const rollback = vi.hoisted(() => vi.fn());
vi.mock("@/server/actions/templates", () => ({ assignTemplateAction: assign, rollbackTemplateAction: rollback }));

import { AssignPanel } from "@/components/templates/assign-panel";
import { VersionHistory } from "@/components/templates/version-history";

const doctors = [
  { id: "019a0000-0000-7000-8000-0000000000d1", name: "Dr Meera Shah", isMe: true },
  { id: "019a0000-0000-7000-8000-0000000000d2", name: "Dr Ravi Rao", isMe: false },
];

describe("AssignPanel", () => {
  it("lets the owner use a dynamic pad for the whole clinic or one doctor", async () => {
    assign.mockResolvedValue({ ok: true });
    render(<AssignPanel templateId="t1" identity="dynamic" boundDoctorId={null} role="owner" doctors={doctors} />);
    fireEvent.click(screen.getByRole("button", { name: "Use for the whole clinic" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith({ scope: "clinic", templateId: "t1" }));
    fireEvent.change(screen.getByLabelText("Or for one doctor"), { target: { value: doctors[1].id } });
    fireEvent.click(screen.getByRole("button", { name: "Use for this doctor" }));
    await waitFor(() => expect(assign).toHaveBeenLastCalledWith({ scope: "doctor", doctorId: doctors[1].id, templateId: "t1" }));
  });

  it("offers a bound pad only to its own doctor", () => {
    render(<AssignPanel templateId="t1" identity="bound" boundDoctorId={doctors[1].id} role="owner" doctors={doctors} />);
    expect(screen.queryByRole("button", { name: "Use for the whole clinic" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use for Dr Ravi Rao" })).toBeInTheDocument();
  });

  it("lets a doctor choose it only for their own prescriptions", async () => {
    assign.mockResolvedValue({ ok: true });
    render(<AssignPanel templateId="t1" identity="dynamic" boundDoctorId={null} role="doctor" doctors={doctors} />);
    expect(screen.queryByRole("button", { name: "Use for the whole clinic" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Use for my prescriptions" }));
    await waitFor(() => expect(assign).toHaveBeenLastCalledWith({ scope: "doctor", doctorId: doctors[0].id, templateId: "t1" }));
  });

  it("shows the server's refusal", async () => {
    assign.mockResolvedValueOnce({ error: "This letterhead belongs to another doctor." });
    render(<AssignPanel templateId="t1" identity="dynamic" boundDoctorId={null} role="owner" doctors={doctors} />);
    fireEvent.click(screen.getByRole("button", { name: "Use for the whole clinic" }));
    expect(await screen.findByText("This letterhead belongs to another doctor.")).toBeInTheDocument();
  });
});

describe("VersionHistory", () => {
  const versions = [
    { versionId: "v2", version: 2, publishedAt: "2026-11-18T05:30:00.000Z" },
    { versionId: "v1", version: 1, publishedAt: "2026-11-17T05:30:00.000Z" },
  ];

  it("offers to publish an older version again, with a preview of each, and the owner only", () => {
    const { unmount } = render(<VersionHistory templateId="t1" currentVersionId="v2" versions={versions} canPublish />);
    expect(screen.getByText(/Version 2 .*\(current\)/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Publish version 1 again" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Publish version 2 again" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Preview version 1" })).toHaveAttribute("href", "/templates/t1/preview?sample=short&version=v1");
    unmount();
    render(<VersionHistory templateId="t1" currentVersionId="v2" versions={versions} canPublish={false} />);
    expect(screen.queryByRole("button", { name: /again/ })).not.toBeInTheDocument();
  });

  it("shows the same refusals as publishing when the old version cannot be used again", async () => {
    rollback.mockResolvedValueOnce({ error: "This pad is the clinic default. A doctor's own letterhead cannot be the clinic default: choose another default first." });
    render(<VersionHistory templateId="t1" currentVersionId="v2" versions={versions} canPublish />);
    fireEvent.click(screen.getByRole("button", { name: "Publish version 1 again" }));
    expect(await screen.findByText(/pad is the clinic default/)).toBeInTheDocument();
    expect(rollback).toHaveBeenCalledWith("t1", "v1");
    rollback.mockResolvedValueOnce({ error: "Another doctor uses this pad. Choose another pad for them first." });
    fireEvent.click(screen.getByRole("button", { name: "Publish version 1 again" }));
    expect(await screen.findByText(/Another doctor uses this pad/)).toBeInTheDocument();
  });
});
