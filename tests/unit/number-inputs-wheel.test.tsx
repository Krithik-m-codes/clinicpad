import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { VitalsSection } from "@/components/rx/vitals-section";
import { ScheduleInput } from "@/components/rx/schedule-input";
import { MedicineRow } from "@/components/rx/medicine-row";
import { InvestigationsSection } from "@/components/rx/investigations-section";
import { emptyMedicine, type EditorState } from "@/lib/rx/editor-state";
import { RX_LIMITS } from "@/lib/domain/rx-options";

function expectWheelBlurs(input: HTMLElement, value: string) {
  input.focus();
  expect(input).toHaveFocus();
  fireEvent.wheel(input, { deltaY: 100 });
  expect(input).not.toHaveFocus();
  expect(input).toHaveValue(Number(value));
}

describe("number inputs ignore the mouse wheel", () => {
  it("vitals", () => {
    const vitals = { pulse: "92" } as unknown as EditorState["vitals"];
    render(<VitalsSection vitals={vitals} notes="" onChange={vi.fn()} onNotesChange={vi.fn()} />);
    expectWheelBlurs(screen.getByLabelText("Pulse (/min)"), "92");
  });

  it("schedule doses", () => {
    render(<ScheduleInput medicine={{ ...emptyMedicine(), doseMorning: "1" }} onChange={vi.fn()} />);
    expectWheelBlurs(screen.getByLabelText("Morning dose"), "1");
  });

  it("duration", () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ medicines: [] }) })));
    render(
      <MedicineRow
        index={0}
        medicine={{ ...emptyMedicine(), durationValue: "5" }}
        canAddToClinic
        onPatch={vi.fn()}
        onPick={vi.fn()}
        onRemove={vi.fn()}
        onSaveFavourite={vi.fn(async () => "")}
        onAddToClinic={vi.fn(async () => "")}
      />,
    );
    expectWheelBlurs(screen.getByLabelText("Duration", { selector: "input" }), "5");
    vi.unstubAllGlobals();
  });
});

describe("InvestigationsSection", () => {
  it("does not show a 'Limit of 0 reached' box when the list is full", () => {
    const items = Array.from({ length: RX_LIMITS.investigations }, (_, i) => ({ key: `k${i}`, name: `Test ${i}`, instructions: "" }));
    render(<InvestigationsSection items={items} onAdd={vi.fn()} onPatch={vi.fn()} onRemove={vi.fn()} />);
    expect(screen.queryByPlaceholderText(/limit of 0/i)).not.toBeInTheDocument();
    expect(screen.getByText(/limit of 30 tests reached/i)).toBeInTheDocument();
  });
});
