import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ScheduleInput } from "@/components/rx/schedule-input";
import { emptyMedicine } from "@/lib/rx/editor-state";

describe("ScheduleInput", () => {
  it("fills all four slots from a preset", () => {
    const onChange = vi.fn();
    render(<ScheduleInput medicine={emptyMedicine()} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Schedule 1-0-1" }));
    expect(onChange).toHaveBeenCalledWith({ doseMorning: "1", doseAfternoon: "0", doseEvening: "", doseNight: "1" });
  });

  it("edits one slot and shows the schedule summary", () => {
    const onChange = vi.fn();
    render(
      <ScheduleInput
        medicine={{ ...emptyMedicine(), doseMorning: "1", doseAfternoon: "0", doseNight: "0.5" }}
        onChange={onChange}
      />,
    );
    expect(screen.getByText(/1-0-½/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Night dose"), { target: { value: "1" } });
    expect(onChange).toHaveBeenCalledWith({ doseNight: "1" });
  });
});
