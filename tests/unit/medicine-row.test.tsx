import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
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
});
