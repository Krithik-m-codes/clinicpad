import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
});
