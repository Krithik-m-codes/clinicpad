import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/server/actions/templates", () => ({ publishTemplateAction: vi.fn(), rollbackTemplateAction: vi.fn() }));

import { overlayDefinitionSchema } from "@/lib/rx-render/overlay-definition";
import { PublishPanel } from "@/components/templates/publish-panel";
import { VersionHistory } from "@/components/templates/version-history";
import { MINIMAL_OVERLAY_DEFINITION } from "../fixtures/overlay-definitions";

const definition = overlayDefinitionSchema.parse(structuredClone(MINIMAL_OVERLAY_DEFINITION));
const doctors = [
  { id: "019a0000-0000-7000-8000-0000000000d1", name: "Dr Asha Rao", isMe: true },
  { id: "019a0000-0000-7000-8000-0000000000d2", name: "Dr Bina Shah", isMe: false },
];
const panel = () => render(<PublishPanel templateId="t1" definition={definition} paper="A4" revision={2} doctors={doctors} canPublish />);

describe("PublishPanel letterhead confirmation (T18-I1)", () => {
  it("asks again when the doctor changes", () => {
    panel();
    fireEvent.click(screen.getByRole("radio", { name: /shows one doctor/ }));
    fireEvent.change(screen.getByLabelText("Whose letterhead is it?"), { target: { value: doctors[0].id } });
    fireEvent.click(screen.getByRole("checkbox", { name: /Dr Asha Rao's name/ }));
    expect(screen.getByRole("button", { name: "Publish" })).toBeEnabled();
    fireEvent.change(screen.getByLabelText("Whose letterhead is it?"), { target: { value: doctors[1].id } });
    expect((screen.getByRole("checkbox", { name: /Dr Bina Shah's name/ }) as HTMLInputElement).checked).toBe(false);
    expect(screen.getByRole("button", { name: "Publish" })).toBeDisabled();
  });

  it("forgets the doctor and the confirmation when the answer changes to 'no doctor' and back", () => {
    panel();
    fireEvent.click(screen.getByRole("radio", { name: /shows one doctor/ }));
    fireEvent.change(screen.getByLabelText("Whose letterhead is it?"), { target: { value: doctors[0].id } });
    fireEvent.click(screen.getByRole("checkbox", { name: /Dr Asha Rao's name/ }));
    fireEvent.click(screen.getByRole("radio", { name: /does not show a doctor/ }));
    fireEvent.click(screen.getByRole("radio", { name: /shows one doctor/ }));
    expect((screen.getByLabelText("Whose letterhead is it?") as HTMLSelectElement).value).toBe("");
    fireEvent.change(screen.getByLabelText("Whose letterhead is it?"), { target: { value: doctors[0].id } });
    expect((screen.getByRole("checkbox", { name: /Dr Asha Rao's name/ }) as HTMLInputElement).checked).toBe(false);
  });
});

describe("VersionHistory (T19 minors)", () => {
  const versions = [
    { versionId: "v2", version: 2, publishedAt: "2026-11-02T00:00:00Z" },
    { versionId: "v1", version: 1, publishedAt: "2026-11-01T00:00:00Z" },
  ];

  it("calls the live version current, not in use", () => {
    render(<VersionHistory templateId="t1" currentVersionId="v2" versions={versions} canPublish />);
    expect(screen.getByText(/\(current\)/)).toBeInTheDocument();
    expect(screen.queryByText(/in use/)).toBeNull();
  });

  it("offers publishing an older version again only when there is no open draft", () => {
    const { unmount } = render(<VersionHistory templateId="t1" currentVersionId="v2" versions={versions} canPublish />);
    expect(screen.getByRole("button", { name: "Publish version 1 again" })).toBeInTheDocument();
    unmount();
    render(<VersionHistory templateId="t1" currentVersionId="v2" versions={versions} canPublish hasDraft />);
    expect(screen.queryByRole("button", { name: /again/ })).toBeNull();
    expect(screen.getByText(/open draft/)).toBeInTheDocument();
  });
});
