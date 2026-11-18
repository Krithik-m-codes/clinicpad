import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { MedicineRow } from "@/components/rx/medicine-row";
import { emptyMedicine, type EditorMedicine } from "@/lib/rx/editor-state";

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => ({ medicines: [] }) })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function setup(medicine: EditorMedicine = emptyMedicine()) {
  const props = {
    onPatch: vi.fn(),
    onPick: vi.fn(),
    onRemove: vi.fn(),
    onSaveFavourite: vi.fn(async () => "Saved as favourite"),
    onAddToClinic: vi.fn(async () => "Added to the clinic list"),
  };
  render(<MedicineRow index={0} medicine={medicine} canAddToClinic {...props} />);
  return props;
}

describe("MedicineRow", () => {
  it("patches the fields it owns", () => {
    const props = setup();
    fireEvent.click(screen.getByRole("button", { name: "Schedule 1-1-1" }));
    expect(props.onPatch).toHaveBeenCalledWith({ doseMorning: "1", doseAfternoon: "1", doseEvening: "", doseNight: "1" });
    fireEvent.click(screen.getByLabelText(/SOS/));
    expect(props.onPatch).toHaveBeenCalledWith({ isSos: true });
    fireEvent.change(screen.getByLabelText("Food"), { target: { value: "after" } });
    expect(props.onPatch).toHaveBeenCalledWith({ foodRelation: "after" });
    fireEvent.change(screen.getByLabelText("Duration unit"), { target: { value: "weeks" } });
    expect(props.onPatch).toHaveBeenCalledWith({ durationUnit: "weeks" });
  });

  it("disables saving a favourite until the line has a name", () => {
    setup();
    expect(screen.getByRole("button", { name: /save as favourite/i })).toBeDisabled();
  });

  it("saves a favourite and reports what happened", async () => {
    const props = setup({ ...emptyMedicine(), drugName: "DOLO 650MG" });
    fireEvent.click(screen.getByRole("button", { name: /save as favourite/i }));
    expect(await screen.findByText("Saved as favourite")).toBeInTheDocument();
    expect(props.onSaveFavourite).toHaveBeenCalledTimes(1);
  });

  it("removes the row", () => {
    const props = setup();
    fireEvent.click(screen.getByRole("button", { name: /^remove$/i }));
    expect(props.onRemove).toHaveBeenCalled();
  });

  describe("async actions", () => {
    const named = { ...emptyMedicine(), drugName: "DOLO 650MG" };

    it("mounts the status region before it has anything to say", () => {
      setup(named);
      const status = screen.getByRole("status");
      expect(status).toBeEmptyDOMElement();
    });

    it("runs a double click once and disables the button while pending", async () => {
      let finish: (message: string) => void = () => undefined;
      const props = setup(named);
      props.onSaveFavourite.mockImplementation(() => new Promise<string>((resolve) => (finish = resolve)));
      const button = screen.getByRole("button", { name: /save as favourite/i });
      fireEvent.click(button);
      fireEvent.click(button);
      expect(props.onSaveFavourite).toHaveBeenCalledTimes(1);
      expect(button).toBeDisabled();
      expect(screen.getByRole("status")).toHaveTextContent("Working…");

      await act(async () => finish("Saved as favourite"));
      expect(screen.getByRole("status")).toHaveTextContent("Saved as favourite");
      expect(button).toBeEnabled();
    });

    it("shows a safe error and re-enables the button when saving rejects", async () => {
      const props = setup(named);
      props.onSaveFavourite.mockRejectedValue(new Error("SQL: secret detail"));
      const button = screen.getByRole("button", { name: /save as favourite/i });
      fireEvent.click(button);
      expect(await screen.findByText("Could not save. Try again.")).toBeInTheDocument();
      expect(screen.getByRole("status")).not.toHaveTextContent("secret");
      expect(button).toBeEnabled();

      props.onSaveFavourite.mockResolvedValue("Saved as favourite");
      fireEvent.click(button);
      expect(await screen.findByText("Saved as favourite")).toBeInTheDocument();
    });

    it("guards and reports errors on the add-to-clinic path as well", async () => {
      const props = setup({ ...emptyMedicine(), drugName: "Zebra syrup" });
      props.onAddToClinic.mockRejectedValue(new Error("boom"));
      fireEvent.focus(screen.getByRole("combobox", { name: "Medicine name" }));
      fireEvent.click(await screen.findByRole("option", { name: /add “Zebra syrup” to the clinic list/i }));
      expect(await screen.findByText("Could not save. Try again.")).toBeInTheDocument();
      expect(props.onAddToClinic).toHaveBeenCalledTimes(1);
      expect(screen.getByRole("button", { name: /save as favourite/i })).toBeEnabled();
    });
  });
});
