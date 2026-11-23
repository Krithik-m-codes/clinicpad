import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState, type FormEvent } from "react";
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

  describe("stale suggestions", () => {
    it("closes the list after a pick and shows nothing for the emptied field", async () => {
      render(<Harness />);
      fireEvent.change(input(), { target: { value: "fev" } });
      fireEvent.click(await screen.findByRole("option", { name: "FEVER WITH CHILLS" }));
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
      fireEvent.focus(input());
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
      expect(screen.queryByRole("option")).not.toBeInTheDocument();
    });

    it("hides the list as soon as the text is cleared", async () => {
      render(<Harness />);
      fireEvent.change(input(), { target: { value: "fev" } });
      await screen.findByRole("listbox");
      fireEvent.change(input(), { target: { value: "" } });
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
      expect(screen.queryByRole("option")).not.toBeInTheDocument();
    });

    it("does not show suggestions for an older query while a newer one is loading", async () => {
      render(<Harness />);
      fireEvent.change(input(), { target: { value: "fev" } });
      await screen.findByRole("option", { name: "FEVER" });
      fireEvent.change(input(), { target: { value: "feve" } });
      expect(screen.queryByRole("option")).not.toBeInTheDocument();
    });
  });

  describe("IME composition", () => {
    it("does not commit on Enter or comma while composing", () => {
      render(<Harness />);
      fireEvent.change(input(), { target: { value: "かぜ" } });
      fireEvent.keyDown(input(), { key: "Enter", isComposing: true });
      fireEvent.keyDown(input(), { key: "Enter", keyCode: 229 });
      fireEvent.keyDown(input(), { key: ",", isComposing: true });
      expect(screen.queryAllByRole("button", { name: /^Remove / })).toHaveLength(0);
      expect(input()).toHaveValue("かぜ");
      fireEvent.keyDown(input(), { key: "Enter" });
      expect(screen.getByRole("button", { name: "Remove かぜ" })).toBeInTheDocument();
    });

    it("tracks compositionstart and compositionend", () => {
      render(<Harness />);
      fireEvent.compositionStart(input());
      fireEvent.change(input(), { target: { value: "bukhar" } });
      fireEvent.keyDown(input(), { key: "Enter" });
      expect(screen.queryAllByRole("button", { name: /^Remove / })).toHaveLength(0);
      fireEvent.compositionEnd(input());
      fireEvent.keyDown(input(), { key: "Enter" });
      expect(screen.getByRole("button", { name: "Remove bukhar" })).toBeInTheDocument();
    });

    it("does not delete a chip with Backspace while composing", () => {
      render(<Harness initial={["A"]} />);
      fireEvent.keyDown(input(), { key: "Backspace", isComposing: true });
      expect(screen.getByRole("button", { name: "Remove A" })).toBeInTheDocument();
    });
  });

  describe("inside a form", () => {
    it("never lets Enter submit the form", async () => {
      const onSubmit = vi.fn((e: FormEvent) => e.preventDefault());
      render(
        <form onSubmit={onSubmit}>
          <Harness />
        </form>,
      );
      // Empty field.
      expect(fireEvent.keyDown(input(), { key: "Enter" })).toBe(false);
      // Typed text is added.
      fireEvent.change(input(), { target: { value: "Cough" } });
      expect(fireEvent.keyDown(input(), { key: "Enter" })).toBe(false);
      expect(screen.getByRole("button", { name: "Remove Cough" })).toBeInTheDocument();
      // A repeat is ignored but still must not submit.
      fireEvent.change(input(), { target: { value: "cough" } });
      expect(fireEvent.keyDown(input(), { key: "Enter" })).toBe(false);
      // With an open, highlighted suggestion.
      fireEvent.change(input(), { target: { value: "fev" } });
      await screen.findByRole("option", { name: "FEVER" });
      fireEvent.keyDown(input(), { key: "ArrowDown" });
      expect(fireEvent.keyDown(input(), { key: "Enter" })).toBe(false);
      expect(screen.getByRole("button", { name: "Remove FEVER" })).toBeInTheDocument();
      expect(onSubmit).not.toHaveBeenCalled();
    });
  });

  describe("accessibility attributes", () => {
    it("references the listbox and the highlighted option only while they exist", async () => {
      render(<Harness />);
      expect(input()).not.toHaveAttribute("aria-controls");
      expect(input()).not.toHaveAttribute("aria-activedescendant");

      fireEvent.change(input(), { target: { value: "fev" } });
      const listbox = await screen.findByRole("listbox");
      expect(input()).toHaveAttribute("aria-controls", listbox.id);
      expect(input()).not.toHaveAttribute("aria-activedescendant");

      fireEvent.keyDown(input(), { key: "ArrowDown" });
      fireEvent.keyDown(input(), { key: "ArrowDown" });
      const second = screen.getAllByRole("option")[1];
      expect(second.id).not.toBe("");
      expect(input()).toHaveAttribute("aria-activedescendant", second.id);
      expect(second).toHaveAttribute("aria-selected", "true");

      fireEvent.keyDown(input(), { key: "Escape" });
      expect(input()).not.toHaveAttribute("aria-controls");
      expect(input()).not.toHaveAttribute("aria-activedescendant");
    });

    it("keeps focus in the field while the list is pressed", async () => {
      render(<Harness />);
      fireEvent.change(input(), { target: { value: "fev" } });
      const listbox = await screen.findByRole("listbox");
      expect(fireEvent.mouseDown(listbox)).toBe(false);
      expect(fireEvent.mouseDown(screen.getAllByRole("option")[0])).toBe(false);
    });
  });

  describe("pasting several phrases", () => {
    const paste = (text: string) => fireEvent.paste(input(), { clipboardData: { getData: () => text } });
    const chips = () => screen.queryAllByRole("button", { name: /^Remove / }).map((b) => b.getAttribute("aria-label"));

    it("splits comma and newline separated text into chips", () => {
      render(<Harness />);
      paste("cough, cold\nfever ,  ,");
      expect(chips()).toEqual(["Remove cough", "Remove cold", "Remove fever"]);
      expect(input()).toHaveValue("");
    });

    it("leaves a single pasted phrase to the browser", () => {
      render(<Harness />);
      expect(paste("just one phrase")).toBe(true);
      expect(chips()).toEqual([]);
    });

    it("respects the limit and de-duplicates in any case", () => {
      render(<Harness initial={["A"]} max={3} />);
      paste("a, b, B, c, d");
      expect(chips()).toEqual(["Remove A", "Remove b", "Remove c"]);
    });

    it("splits a comma that arrives through a plain change event (mobile keyboards)", () => {
      render(<Harness />);
      fireEvent.change(input(), { target: { value: "cough," } });
      expect(chips()).toEqual(["Remove cough"]);
      expect(input()).toHaveValue("");
    });
  });

  describe("long text", () => {
    it("wraps chip text and lets the browser pick its direction", () => {
      const long = "W".repeat(300);
      render(<Harness initial={[long]} />);
      const text = screen.getByText(long);
      expect(text).toHaveAttribute("dir", "auto");
      expect(text.className).toContain("break-words");
    });

    it("wraps suggestion text and lets the browser pick its direction", async () => {
      render(<Harness />);
      fireEvent.change(input(), { target: { value: "fev" } });
      const option = await screen.findByRole("option", { name: "FEVER" });
      expect(option.querySelector("[dir='auto']")).not.toBeNull();
      expect(option.className).toContain("break-words");
    });
  });
});
