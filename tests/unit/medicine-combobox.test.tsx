import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState, type FormEvent } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { MedicineCombobox } from "@/components/rx/medicine-combobox";
import type { MedicineHit } from "@/server/services/catalogue";

const hits: MedicineHit[] = [
  { source: "favourite", id: "f1", name: "DOLO 650MG", genericName: "Paracetamol 650Mg", favourite: null },
  { source: "global", id: "g1", name: "DOLO 1000 TAB", genericName: "Paracetamol 1000Mg", favourite: null },
];

let body: { medicines: MedicineHit[] } = { medicines: hits };

beforeEach(() => {
  body = { medicines: hits };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => body })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function setup(value = "dol") {
  const props = { onTextChange: vi.fn(), onPick: vi.fn(), onAddToClinic: vi.fn() };
  render(<MedicineCombobox value={value} {...props} />);
  return props;
}

describe("MedicineCombobox", () => {
  it("reports free text as typed", () => {
    const props = setup("");
    fireEvent.change(screen.getByRole("combobox", { name: "Medicine name" }), { target: { value: "Zebra syrup" } });
    expect(props.onTextChange).toHaveBeenCalledWith("Zebra syrup");
  });

  it("shows catalogue suggestions with their source and generic name", async () => {
    setup();
    fireEvent.focus(screen.getByRole("combobox", { name: "Medicine name" }));
    const option = await screen.findByRole("option", { name: /DOLO 650MG/ });
    expect(option).toHaveTextContent("Favourite");
    expect(option).toHaveTextContent("Paracetamol 650Mg");
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe("/api/catalogue/search?kind=medicine&q=dol");
  });

  it("picks with the keyboard", async () => {
    const props = setup();
    const input = screen.getByRole("combobox", { name: "Medicine name" });
    fireEvent.focus(input);
    await screen.findByRole("option", { name: /DOLO 1000 TAB/ });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(props.onPick).toHaveBeenCalledWith(hits[1]);
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("picks with the mouse and closes on Escape", async () => {
    const props = setup();
    const input = screen.getByRole("combobox", { name: "Medicine name" });
    fireEvent.focus(input);
    fireEvent.click(await screen.findByRole("option", { name: /DOLO 650MG/ }));
    expect(props.onPick).toHaveBeenCalledWith(hits[0]);

    fireEvent.focus(input);
    await screen.findByRole("listbox");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("offers to add an unknown medicine to the clinic list", async () => {
    body = { medicines: [] };
    const props = setup("Zebra syrup");
    fireEvent.focus(screen.getByRole("combobox", { name: "Medicine name" }));
    fireEvent.click(await screen.findByRole("option", { name: /add “Zebra syrup” to the clinic list/i }));
    expect(props.onAddToClinic).toHaveBeenCalledWith("Zebra syrup");
  });

  it("does not offer to add a name that is already in the list", async () => {
    setup("dolo  650mg");
    fireEvent.focus(screen.getByRole("combobox", { name: "Medicine name" }));
    await screen.findByRole("option", { name: /DOLO 650MG/ });
    expect(screen.queryByRole("option", { name: /clinic list/i })).not.toBeInTheDocument();
  });

  it("moves up with ArrowUp", async () => {
    const props = setup();
    const input = screen.getByRole("combobox", { name: "Medicine name" });
    fireEvent.focus(input);
    await screen.findByRole("option", { name: /DOLO 1000 TAB/ });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowUp" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(props.onPick).toHaveBeenCalledWith(hits[0]);
  });

  it("closes when the field loses focus", async () => {
    setup();
    const input = screen.getByRole("combobox", { name: "Medicine name" });
    fireEvent.focus(input);
    await screen.findByRole("listbox");
    fireEvent.blur(input);
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("keeps focus in the field while an option or the scrollbar is pressed, so the click still picks", async () => {
    const props = setup();
    fireEvent.focus(screen.getByRole("combobox", { name: "Medicine name" }));
    const option = await screen.findByRole("option", { name: /DOLO 1000 TAB/ });
    // A prevented mousedown means the browser never blurs the input, so the list stays open for the click.
    expect(fireEvent.mouseDown(option)).toBe(false);
    expect(fireEvent.mouseDown(screen.getByRole("listbox").parentElement as HTMLElement)).toBe(false);
    fireEvent.click(option);
    expect(props.onPick).toHaveBeenCalledWith(hits[1]);
  });

  it("shows no suggestions from an earlier search after closing and reopening", async () => {
    setup();
    const input = screen.getByRole("combobox", { name: "Medicine name" });
    fireEvent.focus(input);
    await screen.findByRole("option", { name: /DOLO 650MG/ });
    fireEvent.keyDown(input, { key: "Escape" });
    fireEvent.focus(input);
    expect(screen.queryByRole("option", { name: /DOLO 650MG/ })).not.toBeInTheDocument();
    expect(await screen.findByRole("option", { name: /DOLO 650MG/ })).toBeInTheDocument();
  });

  it("cannot pick a suggestion for an older query inside the debounce window", async () => {
    const onPick = vi.fn();
    function Harness() {
      const [value, setValue] = useState("dol");
      return <MedicineCombobox value={value} onTextChange={setValue} onPick={onPick} />;
    }
    render(<Harness />);
    const input = screen.getByRole("combobox", { name: "Medicine name" });
    fireEvent.focus(input);
    await screen.findByRole("option", { name: /DOLO 650MG/ });
    fireEvent.change(input, { target: { value: "dolox" } });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onPick).not.toHaveBeenCalled();
    expect(screen.queryByRole("option", { name: /DOLO 650MG/ })).not.toBeInTheDocument();
  });

  it("does not pick while an IME composition is in progress", async () => {
    const props = setup();
    const input = screen.getByRole("combobox", { name: "Medicine name" });
    fireEvent.focus(input);
    await screen.findByRole("option", { name: /DOLO 650MG/ });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
    expect(props.onPick).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(props.onPick).toHaveBeenCalledWith(hits[0]);
  });

  describe("inside a form", () => {
    function renderInForm(value: string) {
      const onSubmit = vi.fn((e: FormEvent) => e.preventDefault());
      const props = { onTextChange: vi.fn(), onPick: vi.fn(), onAddToClinic: vi.fn() };
      render(
        <form onSubmit={onSubmit}>
          <MedicineCombobox value={value} {...props} />
        </form>,
      );
      return { onSubmit, props, input: screen.getByRole("combobox", { name: "Medicine name" }) };
    }

    it("never lets Enter submit the form, whether closed, open, or highlighted", async () => {
      const { onSubmit, props, input } = renderInForm("dol");
      // Closed list.
      expect(fireEvent.keyDown(input, { key: "Enter" })).toBe(false);
      // Open list with nothing highlighted: the typed text stays as it is.
      fireEvent.focus(input);
      await screen.findByRole("option", { name: /DOLO 650MG/ });
      expect(fireEvent.keyDown(input, { key: "Enter" })).toBe(false);
      expect(props.onPick).not.toHaveBeenCalled();
      expect(screen.getByRole("listbox")).toBeInTheDocument();
      // Highlighted option.
      fireEvent.keyDown(input, { key: "ArrowDown" });
      expect(fireEvent.keyDown(input, { key: "Enter" })).toBe(false);
      expect(props.onPick).toHaveBeenCalledWith(hits[0]);
      expect(onSubmit).not.toHaveBeenCalled();
    });

    it("never lets Enter submit the form from an empty field", () => {
      const { onSubmit, input } = renderInForm("");
      expect(fireEvent.keyDown(input, { key: "Enter" })).toBe(false);
      expect(onSubmit).not.toHaveBeenCalled();
    });
  });

  describe("accessibility attributes", () => {
    it("references the listbox and the highlighted option only while they exist", async () => {
      setup();
      const input = screen.getByRole("combobox", { name: "Medicine name" });
      expect(input).not.toHaveAttribute("aria-controls");
      expect(input).not.toHaveAttribute("aria-activedescendant");
      expect(input).toHaveAttribute("aria-expanded", "false");

      fireEvent.focus(input);
      const listbox = await screen.findByRole("listbox");
      expect(input).toHaveAttribute("aria-controls", listbox.id);
      expect(input).toHaveAttribute("aria-expanded", "true");
      expect(input).not.toHaveAttribute("aria-activedescendant");

      fireEvent.keyDown(input, { key: "ArrowDown" });
      const first = screen.getAllByRole("option")[0];
      expect(input).toHaveAttribute("aria-activedescendant", first.id);
      expect(first).toHaveAttribute("aria-selected", "true");

      fireEvent.keyDown(input, { key: "Escape" });
      expect(input).not.toHaveAttribute("aria-controls");
      expect(input).not.toHaveAttribute("aria-activedescendant");
    });
  });

  describe("hostile text", () => {
    it("renders script-like and very long catalogue text inertly", async () => {
      const evil = `<img src=x onerror="alert(1)"><script>alert(2)</script>`;
      const long = "A".repeat(5000);
      body = {
        medicines: [{ source: "clinic", id: "c1", name: evil, genericName: long, favourite: null }],
      };
      const { container } = render(<MedicineCombobox value={long} onTextChange={vi.fn()} onPick={vi.fn()} />);
      fireEvent.focus(screen.getByRole("combobox", { name: "Medicine name" }));
      const option = await screen.findByRole("option");
      expect(option).toHaveTextContent(evil);
      expect(option).toHaveTextContent(long);
      expect(container.querySelector("img")).toBeNull();
      expect(container.querySelector("script")).toBeNull();
    });
  });
});
