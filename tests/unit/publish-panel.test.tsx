import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
const publish = vi.hoisted(() => vi.fn());
vi.mock("@/server/actions/templates", () => ({ publishTemplateAction: publish }));

import { overlayDefinitionSchema } from "@/lib/rx-render/overlay-definition";
import { EditorDirtyProvider } from "@/components/templates/editor-dirty";
import { PublishPanel } from "@/components/templates/publish-panel";
import { MINIMAL_OVERLAY_DEFINITION } from "../fixtures/overlay-definitions";

const definition = overlayDefinitionSchema.parse(structuredClone(MINIMAL_OVERLAY_DEFINITION));
const doctors = [{ id: "019a0000-0000-7000-8000-0000000000d1", name: "Dr Meera Shah", isMe: true }];
const panel = (over: Partial<Parameters<typeof PublishPanel>[0]> = {}) =>
  render(<PublishPanel templateId="t1" definition={definition} paper="A4" revision={2} doctors={doctors} canPublish dirty={false} {...over} />);

describe("PublishPanel", () => {
  it("has no preselected answer to the letterhead question", () => {
    panel();
    expect(screen.getAllByRole("radio").every((r) => !(r as HTMLInputElement).checked)).toBe(true);
    expect(screen.getByRole("button", { name: "Publish" })).toBeDisabled();
  });

  it("publishes a dynamic pad without a doctor and without the confirmation", async () => {
    publish.mockResolvedValueOnce({ ok: true });
    panel();
    fireEvent.click(screen.getByRole("radio", { name: /does not show a doctor/ }));
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    await waitFor(() => expect(publish).toHaveBeenCalledWith("t1", { identity: "dynamic", boundDoctorId: null, confirmLetterhead: false, acknowledgedOmitted: [], baseRevision: 2 }));
    expect(await screen.findByText(/Published\. Choose who uses it/)).toBeInTheDocument();
  });

  it("needs a doctor and the confirmation for a doctor's own letterhead", async () => {
    publish.mockResolvedValueOnce({ ok: true });
    panel();
    fireEvent.click(screen.getByRole("radio", { name: /shows one doctor/ }));
    expect(screen.getByRole("button", { name: "Publish" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Whose letterhead is it?"), { target: { value: doctors[0].id } });
    expect(screen.getByRole("button", { name: "Publish" })).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: /shows Dr Meera Shah's name and registration number/ }));
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    await waitFor(() => expect(publish).toHaveBeenCalledWith("t1", { identity: "bound", boundDoctorId: doctors[0].id, confirmLetterhead: true, acknowledgedOmitted: [], baseRevision: 2 }));
  });

  it("shows the server's refusal and its listed problems", async () => {
    publish.mockResolvedValueOnce({ error: "This pad is the clinic default. A doctor's own letterhead cannot be the clinic default: choose another default first." });
    panel();
    fireEvent.click(screen.getByRole("radio", { name: /does not show a doctor/ }));
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    expect(await screen.findByText(/pad is the clinic default/)).toBeInTheDocument();
  });

  it("lists what blocks publishing", () => {
    panel({ definition: { ...definition, boxes: [] } });
    fireEvent.click(screen.getByRole("radio", { name: /does not show a doctor/ }));
    expect(screen.getByText("Add a box for the patient's name.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Publish" })).toBeDisabled();
  });

  it("tells a doctor that the owner publishes, and asks to save first", () => {
    const { unmount } = panel({ canPublish: false });
    expect(screen.getByText(/clinic owner publishes/)).toBeInTheDocument();
    unmount();
    panel({ dirty: true });
    expect(screen.getByText(/Save the draft before publishing/)).toBeInTheDocument();
  });

  it("also waits for the editor to save its unsaved changes", () => {
    render(
      <EditorDirtyProvider value>
        <PublishPanel templateId="t1" definition={definition} paper="A4" revision={2} doctors={doctors} canPublish />
      </EditorDirtyProvider>,
    );
    fireEvent.click(screen.getByRole("radio", { name: /does not show a doctor/ }));
    expect(screen.getByText(/Save the draft before publishing/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Publish" })).toBeDisabled();
  });

  it("lists the sections the pad leaves off and needs a ticked confirmation before publishing", async () => {
    publish.mockResolvedValueOnce({ ok: true });
    panel({ definition: { ...definition, flow: { ...definition.flow, sections: definition.flow.sections.filter((k) => k !== "advice") } } });
    fireEvent.click(screen.getByRole("radio", { name: /does not show a doctor/ }));
    expect(screen.getByText(/does not print these sections/i)).toHaveTextContent("Advice");
    expect(screen.getByRole("button", { name: "Publish" })).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: /without these sections/i }));
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    await waitFor(() => expect(publish).toHaveBeenCalledWith("t1", { identity: "dynamic", boundDoctorId: null, confirmLetterhead: false, acknowledgedOmitted: ["advice"], baseRevision: 2 }));
  });
});
