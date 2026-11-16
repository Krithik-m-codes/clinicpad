import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { TermListInput } from "@/components/rx/term-list-input";

function Harness({ initial = [] as string[], max = 5 }) {
  const [values, setValues] = useState(initial);
  return <TermListInput label="Complaints" kind="complaint" values={values} onChange={setValues} max={max} />;
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => ({ terms: ["FEVER", "FEVER WITH CHILLS"] }) })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const input = () => screen.getByLabelText("Complaints");

describe("TermListInput", () => {
  it("adds a suggestion on click", async () => {
    render(<Harness />);
    fireEvent.change(input(), { target: { value: "fev" } });
    fireEvent.click(await screen.findByRole("option", { name: "FEVER WITH CHILLS" }));
    expect(screen.getByRole("button", { name: "Remove FEVER WITH CHILLS" })).toBeInTheDocument();
    expect(input()).toHaveValue("");
  });

  it("adds typed text on Enter or comma and ignores repeats in any case", () => {
    render(<Harness />);
    fireEvent.change(input(), { target: { value: "Cough" } });
    fireEvent.keyDown(input(), { key: "Enter" });
    fireEvent.change(input(), { target: { value: "cough" } });
    fireEvent.keyDown(input(), { key: "Enter" });
    fireEvent.change(input(), { target: { value: "Cold" } });
    fireEvent.keyDown(input(), { key: "," });
    expect(screen.getAllByRole("button", { name: /^Remove / }).map((b) => b.getAttribute("aria-label"))).toEqual([
      "Remove Cough",
      "Remove Cold",
    ]);
  });

  it("keeps a typed phrase when the field loses focus", () => {
    render(<Harness />);
    fireEvent.change(input(), { target: { value: "  Headache  " } });
    fireEvent.blur(input());
    expect(screen.getByRole("button", { name: "Remove Headache" })).toBeInTheDocument();
  });

  it("removes chips with the button or Backspace", () => {
    render(<Harness initial={["A", "B"]} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove A" }));
    fireEvent.keyDown(input(), { key: "Backspace" });
    expect(screen.queryAllByRole("button", { name: /^Remove / })).toHaveLength(0);
  });

  it("stops at the limit", () => {
    render(<Harness initial={["A", "B"]} max={2} />);
    expect(input()).toBeDisabled();
    expect(input()).toHaveAttribute("placeholder", "Limit of 2 reached");
  });
});
