import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
const save = vi.hoisted(() => vi.fn());
vi.mock("@/server/actions/templates", () => ({ saveTemplateDraftAction: save, discardTemplateDraftAction: vi.fn() }));
vi.mock("@fontsource/noto-sans-devanagari/400.css", () => ({}));
vi.mock("@fontsource/noto-sans-devanagari/700.css", () => ({}));

import { overlayDefinitionSchema } from "@/lib/rx-render/overlay-definition";
import { TemplateEditor } from "@/components/templates/template-editor";
import { MINIMAL_OVERLAY_DEFINITION } from "../fixtures/overlay-definitions";

Object.defineProperty(document, "fonts", { value: { ready: Promise.resolve() }, configurable: true });
const definition = overlayDefinitionSchema.parse(structuredClone(MINIMAL_OVERLAY_DEFINITION));
const preprinted = overlayDefinitionSchema.parse({ ...structuredClone(MINIMAL_OVERLAY_DEFINITION), background: { ...MINIMAL_OVERLAY_DEFINITION.background, printMode: "pdf_only" } });
const editor = (def = definition) => render(<TemplateEditor templateId="t1" name="My pad" fileId="f1" paper="A4" labels="en" definition={def} revision={1} />);

afterEach(() => {
  save.mockReset();
  vi.restoreAllMocks();
});

/** One keystroke: the browser sets the whole new value of the field it is typing in. */
const type = (input: HTMLElement, keys: string) => {
  fireEvent.focus(input);
  let value = "";
  for (const key of keys) {
    value += key;
    fireEvent.change(input, { target: { value } });
  }
};
const selectName = () => fireEvent.focus(screen.getByRole("button", { name: /Patient's name box/ }));

describe("typing into the number fields (T17-I2)", () => {
  it("lets 12 be typed into the font size (the 1 is below the minimum)", () => {
    editor();
    selectName();
    const size = screen.getByLabelText("Size (pt)") as HTMLInputElement;
    type(size, "1");
    expect(size.value).toBe("1");
    type(size, "12");
    expect(size.value).toBe("12");
    fireEvent.blur(size);
    expect(size.value).toBe("12");
  });

  it("lets 25 be typed into the width and clamps to the minimum only when the field is left", () => {
    editor();
    selectName();
    const width = screen.getByLabelText("Width (mm)") as HTMLInputElement;
    type(width, "2");
    expect(width.value).toBe("2");
    type(width, "25");
    expect(width.value).toBe("25");
    fireEvent.blur(width);
    expect(screen.getByRole("button", { name: /Patient's name box at 20 by 52 mm, 25 by 7 mm/ })).toBeInTheDocument();
    type(width, "1");
    fireEvent.blur(width);
    expect(Number((screen.getByLabelText("Width (mm)") as HTMLInputElement).value)).toBeGreaterThanOrEqual(3);
  });

  it("commits on Enter too, and shows the clamped number", () => {
    editor();
    selectName();
    const size = screen.getByLabelText("Size (pt)") as HTMLInputElement;
    type(size, "2");
    fireEvent.keyDown(size, { key: "Enter" });
    expect(size.value).toBe("6");
  });

  it("keeps what is typed in the offset fields (a lone minus reads as empty in the browser and changes nothing)", () => {
    editor(preprinted);
    const move = screen.getByLabelText(/Move right/) as HTMLInputElement;
    type(move, "-");
    expect(screen.queryByText(/Save the draft to preview/)).toBeNull();
    type(move, "-1");
    expect(move.value).toBe("-1");
    type(move, "-12");
    expect(move.value).toBe("-12");
    fireEvent.blur(move);
    expect(move.value).toBe("-10");
    type(move, "-1.5");
    fireEvent.blur(move);
    expect(move.value).toBe("-1.5");
  });

  it("clamps an offset above 10 straight away", () => {
    editor(preprinted);
    const move = screen.getByLabelText(/Move down/) as HTMLInputElement;
    type(move, "99");
    fireEvent.blur(move);
    expect(move.value).toBe("10");
  });

  it("keeps the offset fields when pre-printed is switched off, and resets the offset", () => {
    editor({ ...preprinted, printOffsetMm: { x: 2, y: 3 } });
    fireEvent.click(screen.getByRole("checkbox", { name: /pre-printed pads/ }));
    expect(screen.queryByLabelText(/Move right/)).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: /pre-printed pads/ }));
    expect((screen.getByLabelText(/Move right/) as HTMLInputElement).value).toBe("0");
    expect((screen.getByLabelText(/Move down/) as HTMLInputElement).value).toBe("0");
  });
});

describe("a save in flight (T17-I1)", () => {
  function deferred() {
    let resolve: (v: unknown) => void = () => {};
    save.mockImplementationOnce(() => new Promise((r) => (resolve = r)));
    return (v: unknown) => resolve(v);
  }

  it("stays dirty when the box was moved after the save started, and sends what was saved", async () => {
    const finish = deferred();
    editor();
    const box = () => screen.getByRole("button", { name: /Patient's name box/ });
    fireEvent.keyDown(box(), { key: "ArrowRight" });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    fireEvent.keyDown(box(), { key: "ArrowRight", shiftKey: true });
    await act(async () => finish({ ok: true, revision: 2 }));
    expect(box().getAttribute("aria-label")).toMatch(/at 26 by 52 mm/);
    expect(screen.getByRole("button", { name: "Save draft" })).toBeEnabled();
    expect(screen.getByText(/Save the draft to preview or publish/)).toBeInTheDocument();
  });

  it("is clean when nothing changed during the save", async () => {
    const finish = deferred();
    editor();
    fireEvent.keyDown(screen.getByRole("button", { name: /Patient's name box/ }), { key: "ArrowRight" });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await act(async () => finish({ ok: true, revision: 2 }));
    expect(screen.getByRole("button", { name: "Saved" })).toBeDisabled();
  });

  it("stays dirty when the headings language changed during the save", async () => {
    const finish = deferred();
    editor();
    fireEvent.keyDown(screen.getByRole("button", { name: /Patient's name box/ }), { key: "ArrowRight" });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    fireEvent.change(screen.getByLabelText("Headings"), { target: { value: "hi" } });
    await act(async () => finish({ ok: true, revision: 2 }));
    expect(screen.getByRole("button", { name: "Save draft" })).toBeEnabled();
  });
});

describe("dragging a box (T17 minors)", () => {
  function sized() {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(210); // 1 px = 1 mm on A4
  }
  const name = () => screen.getByRole("button", { name: /Patient's name box/ });

  it("places the box from where the drag started, so a clamped excursion does not move it", () => {
    sized();
    editor();
    fireEvent.pointerDown(name(), { clientX: 100, clientY: 100, button: 0, pointerId: 1 });
    fireEvent.pointerMove(name(), { clientX: 300, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(name(), { clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerUp(name(), { pointerId: 1 });
    expect(name().getAttribute("aria-label")).toMatch(/at 20 by 52 mm/);
  });

  it("ignores a drag started with a non-primary button", () => {
    sized();
    editor();
    fireEvent.pointerDown(name(), { clientX: 100, clientY: 100, button: 2, pointerId: 1 });
    fireEvent.pointerMove(name(), { clientX: 130, clientY: 100, pointerId: 1 });
    expect(name().getAttribute("aria-label")).toMatch(/at 20 by 52 mm/);
  });

  it("moves the box by the pointer distance", () => {
    sized();
    editor();
    fireEvent.pointerDown(name(), { clientX: 100, clientY: 100, button: 0, pointerId: 1 });
    fireEvent.pointerMove(name(), { clientX: 110, clientY: 105, pointerId: 1 });
    expect(name().getAttribute("aria-label")).toMatch(/at 30 by 57 mm/);
  });

  it("lets the inputs step by a tenth of a millimetre", async () => {
    editor();
    selectName();
    await waitFor(() => expect(screen.getByLabelText("Left (mm)").getAttribute("step")).toBe("0.1"));
  });
});
