import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
const save = vi.hoisted(() => vi.fn());
const discard = vi.hoisted(() => vi.fn());
vi.mock("@/server/actions/templates", () => ({ saveTemplateDraftAction: save, discardTemplateDraftAction: discard }));
vi.mock("@fontsource/noto-sans-devanagari/400.css", () => ({}));
vi.mock("@fontsource/noto-sans-devanagari/700.css", () => ({}));

import { overlayDefinitionSchema, type OverlayBox } from "@/lib/rx-render/overlay-definition";
import { TemplateEditor } from "@/components/templates/template-editor";
import { longSampleText, overflowingBoxes } from "@/components/templates/use-overflow-warnings";
import { MINIMAL_OVERLAY_DEFINITION } from "../fixtures/overlay-definitions";

Object.defineProperty(document, "fonts", { value: { ready: Promise.resolve() }, configurable: true });
const definition = overlayDefinitionSchema.parse(structuredClone(MINIMAL_OVERLAY_DEFINITION));
const editor = () => render(<TemplateEditor templateId="t1" name="My pad" fileId="f1" paper="A4" labels="en" definition={definition} revision={3} />);

afterEach(() => {
  vi.clearAllMocks();
  save.mockReset();
  discard.mockReset();
});

describe("TemplateEditor", () => {
  it("moves the focused box with the arrow keys, 5 mm with Shift, and announces its position", () => {
    editor();
    const box = screen.getByRole("button", { name: /Patient's name box at 20 by 52 mm/ });
    fireEvent.keyDown(box, { key: "ArrowRight" });
    fireEvent.keyDown(box, { key: "ArrowDown", shiftKey: true });
    expect(screen.getByRole("button", { name: /Patient's name box at 21 by 57 mm/ })).toBeInTheDocument();
    fireEvent.focus(screen.getByRole("button", { name: /Patient's name box at 21 by 57 mm/ }));
    expect(screen.getByTestId("box-position")).toHaveTextContent("Patient's name: 21 by 57 mm, 90 by 7 mm.");
  });

  it("resizes with Alt and the arrow keys", () => {
    editor();
    fireEvent.keyDown(screen.getByRole("button", { name: /Patient's name box/ }), { key: "ArrowRight", altKey: true, shiftKey: true });
    expect(screen.getByRole("button", { name: /Patient's name box at 20 by 52 mm, 95 by 7 mm/ })).toBeInTheDocument();
  });

  it("removes a box with Delete and adds one from the picker", () => {
    editor();
    fireEvent.keyDown(screen.getByRole("button", { name: /Date box/ }), { key: "Delete" });
    expect(screen.queryByRole("button", { name: /Date box/ })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Add a box for"), { target: { value: "visit.rx_no" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(screen.getByRole("button", { name: /Rx no\. \(blank on drafts\) box/ })).toBeInTheDocument();
  });

  it("stops adding a second logo box and says why", () => {
    editor();
    fireEvent.change(screen.getByLabelText("Add a box for"), { target: { value: "clinic.logo" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(screen.getByRole("button", { name: "Add" })).toBeDisabled();
    expect(screen.getByText(/only one box for this image/)).toBeInTheDocument();
  });

  it("shows the server's spacer rule and blocks saving while it is broken", () => {
    editor();
    fireEvent.change(screen.getByLabelText("From top (mm)"), { target: { value: "100" } });
    expect(screen.getByText(/space above the body is too tall/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save draft" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("From top (mm)"), { target: { value: "64" } });
    expect(screen.queryByText(/space above the body is too tall/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save draft" })).toBeEnabled();
  });

  it("warns on boxes whose long sample text does not fit", async () => {
    const scroll = vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(100);
    const client = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(10);
    try {
      editor();
      expect(await screen.findByRole("button", { name: /Patient's name box.*long values may not fit/ })).toBeInTheDocument();
    } finally {
      scroll.mockRestore();
      client.mockRestore();
    }
  });

  it("saves with the revision it loaded, then the next one", async () => {
    save.mockResolvedValueOnce({ ok: true, revision: 4 }).mockResolvedValueOnce({ ok: true, revision: 5 });
    editor();
    expect(screen.getByRole("button", { name: "Saved" })).toBeDisabled();
    fireEvent.keyDown(screen.getByRole("button", { name: /Patient's name box/ }), { key: "ArrowLeft" });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith("t1", expect.objectContaining({ baseRevision: 3, labels: "en" })));
    await waitFor(() => expect(screen.getByRole("button", { name: "Saved" })).toBeDisabled());
    fireEvent.keyDown(screen.getByRole("button", { name: /Patient's name box/ }), { key: "ArrowLeft" });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(save).toHaveBeenLastCalledWith("t1", expect.objectContaining({ baseRevision: 4 })));
  });

  it("tells the user to reload on a revision conflict", async () => {
    save.mockResolvedValueOnce({ error: "This pad was changed in another window. Reload to see the latest version.", currentRevision: 9 });
    editor();
    fireEvent.keyDown(screen.getByRole("button", { name: /Patient's name box/ }), { key: "ArrowUp" });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    expect(await screen.findByText(/another window.*Reload the page/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reload now" })).toBeInTheDocument();
  });

  it("asks before discarding the draft, and discards on yes", async () => {
    discard.mockResolvedValueOnce({ ok: true });
    editor();
    fireEvent.click(screen.getByRole("button", { name: "Discard draft" }));
    expect(discard).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Yes, discard" }));
    await waitFor(() => expect(discard).toHaveBeenCalledWith("t1"));
  });
});

describe("overflowingBoxes", () => {
  const box = (id: string, field: OverlayBox["field"]): OverlayBox => ({ id, field, xMm: 0, yMm: 0, wMm: 10, hMm: 5, fontPt: 10, align: "left", bold: false, repeat: "every_page" });

  it("flags only boxes the measure says overflow, and skips empty values and image fields", () => {
    const text = { "doctor.name": "long", "clinic.name": "", "patient.name": "short" };
    const out = overflowingBoxes([box("a", "doctor.name"), box("b", "clinic.name"), box("c", "patient.name"), box("d", "clinic.logo")], text, (_b, value) => value === "long");
    expect([...out]).toEqual(["a"]);
  });

  it("long sample text has long doctor and clinic values and joins address lines with newlines", () => {
    const text = longSampleText("en");
    expect(text["doctor.name"]).toContain("Ramachandran");
    expect(text["clinic.address"]).toContain("\n");
    expect(text["visit.rx_no"]).toBe("");
  });
});
