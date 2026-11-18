import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PrintInspector } from "@/components/templates/print-inspector";
import { spacerLimitMm } from "@/lib/rx-render/overlay-definition";
import { overlayDefinition } from "../fixtures/overlay-documents";

afterEach(cleanup);
const ID = "00000000-0000-4000-8000-000000000009";
const pre = (printOffsetMm = { x: 0, y: 0 }) => overlayDefinition({ background: { printMode: "pdf_only" }, printOffsetMm });

describe("PrintInspector", () => {
  it("shows nothing but the switch for letterhead-on-every-print pads", () => {
    render(<PrintInspector templateId={ID} paper="A4" definition={overlayDefinition()} dirty={false} dispatch={vi.fn()} />);
    expect(screen.getByRole("checkbox")).not.toBeChecked();
    expect(screen.queryByText(/Move right/)).toBeNull();
  });

  it("turns pre-printed mode on and off through the editor", () => {
    const dispatch = vi.fn();
    render(<PrintInspector templateId={ID} paper="A4" definition={overlayDefinition()} dirty={false} dispatch={dispatch} />);
    fireEvent.click(screen.getByRole("checkbox"));
    expect(dispatch).toHaveBeenCalledWith({ type: "options", patch: { background: { printMode: "pdf_only" } } });
  });

  it("edits the offset in tenths of a millimetre, clamped to 10 mm, and ignores an empty field", () => {
    const dispatch = vi.fn();
    render(<PrintInspector templateId={ID} paper="A4" definition={pre({ x: 1, y: 2 })} dirty={false} dispatch={dispatch} />);
    fireEvent.change(screen.getByLabelText(/Move right/), { target: { value: "99" } });
    expect(dispatch).toHaveBeenLastCalledWith({ type: "options", patch: { printOffsetMm: { x: 10, y: 2 } } });
    fireEvent.change(screen.getByLabelText(/Move down/), { target: { value: "-1.26" } });
    expect(dispatch).toHaveBeenLastCalledWith({ type: "options", patch: { printOffsetMm: { x: 1, y: -1.3 } } });
    dispatch.mockClear();
    fireEvent.change(screen.getByLabelText(/Move down/), { target: { value: "" } });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("states the same spacer limit as the publish rule, offset included, and the 100 percent advice", () => {
    const def = pre({ x: 0, y: 10 });
    render(<PrintInspector templateId={ID} paper="A4" definition={def} dirty={false} dispatch={vi.fn()} />);
    expect(screen.getByText(new RegExp(`at most ${spacerLimitMm("A4", def.pageNumbers.bandMm, 10)} mm`))).toBeTruthy();
    expect(screen.getByText(/Actual size/)).toBeTruthy();
  });

  it("offers the alignment check only for a saved draft", () => {
    const { rerender } = render(<PrintInspector templateId={ID} paper="A4" definition={pre()} dirty={true} dispatch={vi.fn()} />);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText(/Save the draft/)).toBeTruthy();
    rerender(<PrintInspector templateId={ID} paper="A4" definition={pre()} dirty={false} dispatch={vi.fn()} />);
    const link = screen.getByRole("link", { name: /alignment check/ });
    expect(link.getAttribute("href")).toBe(`/templates/${ID}/alignment`);
    expect(link.getAttribute("rel")).toContain("noopener");
  });
});
