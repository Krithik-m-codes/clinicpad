import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { AutosaveStatusBar, describePath } from "@/components/rx/autosave-status";
import { AMBIGUOUS_CONFLICT_MESSAGE, OFFLINE_MESSAGE, type AutosaveStatus } from "@/lib/rx/autosave";

function setup(status: AutosaveStatus) {
  const handlers = { onRetry: vi.fn(), onOverwrite: vi.fn(), onReload: vi.fn() };
  render(<AutosaveStatusBar status={status} {...handlers} />);
  return handlers;
}

describe("AutosaveStatusBar", () => {
  it("says when everything is saved, and when nothing needed saving", () => {
    setup({ state: "saved", savedAt: "2026-11-12T04:30:00.000Z" });
    expect(screen.getByRole("status")).toHaveTextContent(/all changes saved at/i);
  });

  it("says nothing is unsaved right after loading", () => {
    setup({ state: "saved", savedAt: null });
    expect(screen.getByRole("status")).toHaveTextContent("No unsaved changes");
  });

  const progress: [AutosaveStatus, RegExp][] = [
    [{ state: "pending" }, /unsaved changes/i],
    [{ state: "saving" }, /saving/i],
  ];
  it.each(progress)("shows progress for %j", (status, text) => {
    setup(status);
    expect(screen.getByRole("status")).toHaveTextContent(text);
  });

  it("shows that changes are not saved while retrying, with a retry button", () => {
    const h = setup({ state: "retrying", message: OFFLINE_MESSAGE, retryInMs: 2000 });
    expect(screen.getByRole("alert")).toHaveTextContent(/not saved yet/i);
    fireEvent.click(screen.getByRole("button", { name: /retry now/i }));
    expect(h.onRetry).toHaveBeenCalled();
  });

  it("explains a rejected save", () => {
    setup({ state: "invalid", message: "Pulse must be at most 250", field: "vitals" });
    expect(screen.getByRole("alert")).toHaveTextContent("Pulse must be at most 250");
  });

  it("says everything since the last save is unsaved, with the time and where the problem is", () => {
    setup({ state: "invalid", message: "Keep this to at most 60 characters", field: "items", path: "items.2.dose", savedAt: "2026-11-12T04:30:00.000Z" });
    const text = screen.getByRole("alert").textContent ?? "";
    expect(text).toMatch(/^Nothing since \d{1,2}:\d{2}.* is saved/);
    expect(text).toContain("Keep this to at most 60 characters");
    expect(text).toContain("(medicines 3 \u00b7 dose)");
  });

  it("shows the label the editor uses for a vital, and falls back to the raw key", () => {
    expect(describePath("vitals.temperatureF")).toBe("vitals \u00b7 Temperature (\u00b0F)");
    expect(describePath("items.0.doseMorning")).toBe("medicines 1 \u00b7 doseMorning");
  });

  it("names the whole draft when there has been no save yet", () => {
    setup({ state: "invalid", message: "Pulse must be at most 250", field: "vitals" });
    expect(screen.getByRole("alert")).toHaveTextContent(/^Nothing since you opened this draft is saved/);
  });

  it("offers reload or keep-mine on a conflict", () => {
    const h = setup({ state: "conflict", message: "This draft was changed in another window or device.", currentRevision: 3 });
    expect(screen.getByRole("alert")).toHaveTextContent(/your version has not been saved/i);
    fireEvent.click(screen.getByRole("button", { name: /reload latest version/i }));
    fireEvent.click(screen.getByRole("button", { name: /keep my version/i }));
    expect(h.onReload).toHaveBeenCalled();
    expect(h.onOverwrite).toHaveBeenCalled();
  });

  it("after an ambiguous failure, says the last save may have gone through and offers both choices", () => {
    const h = setup({ state: "conflict", message: AMBIGUOUS_CONFLICT_MESSAGE, currentRevision: 4 });
    expect(screen.getByRole("alert")).toHaveTextContent(AMBIGUOUS_CONFLICT_MESSAGE);
    expect(screen.getByRole("alert")).not.toHaveTextContent(/has not been saved/i);
    fireEvent.click(screen.getByRole("button", { name: /load saved version/i }));
    fireEvent.click(screen.getByRole("button", { name: /keep my version/i }));
    expect(h.onReload).toHaveBeenCalled();
    expect(h.onOverwrite).toHaveBeenCalled();
  });

  it("offers a reload when the prescription is locked", () => {
    const h = setup({ state: "locked", message: "This prescription is finalized." });
    fireEvent.click(screen.getByRole("button", { name: /^reload$/i }));
    expect(h.onReload).toHaveBeenCalled();
  });
});
