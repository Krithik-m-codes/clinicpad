import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { AutosaveStatusBar } from "@/components/rx/autosave-status";
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
    expect(screen.getByRole("alert")).toHaveTextContent("Not saved: Pulse must be at most 250");
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
