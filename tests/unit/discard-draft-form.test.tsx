import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const refresh = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

import { DiscardDraftForm } from "@/components/rx/discard-draft-form";

const WARNING = "This draft and everything in it are deleted.";

beforeEach(() => refresh.mockClear());

describe("DiscardDraftForm", () => {
  it("asks first: focus moves to Keep it and the warning sits in a polite live region", () => {
    render(<DiscardDraftForm action={vi.fn()} label="Discard draft" warning={WARNING} />);
    const live = document.querySelector('[aria-live="polite"]');
    expect(live).not.toBeNull();
    expect(live).toBeEmptyDOMElement();

    fireEvent.click(screen.getByRole("button", { name: "Discard draft" }));

    expect(screen.getByRole("button", { name: "Keep it" })).toHaveFocus();
    expect(live).toHaveTextContent(WARNING);
    expect(screen.getByRole("button", { name: "Yes, discard draft" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Keep it" }));
    expect(live).toBeEmptyDOMElement();
    expect(screen.getByRole("button", { name: "Discard draft" })).toBeInTheDocument();
  });

  it("does not call the action until the user confirms", () => {
    const action = vi.fn(async () => ({}));
    render(<DiscardDraftForm action={action} label="Discard draft" warning={WARNING} />);
    fireEvent.click(screen.getByRole("button", { name: "Discard draft" }));
    fireEvent.click(screen.getByRole("button", { name: "Keep it" }));
    expect(action).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("after a failed discard shows the message and refreshes the page", async () => {
    const action = vi.fn(async () => ({ error: "This draft was changed or discarded elsewhere." }));
    render(<DiscardDraftForm action={action} label="Discard draft" warning={WARNING} />);
    fireEvent.click(screen.getByRole("button", { name: "Discard draft" }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, discard draft" }));

    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(screen.getByText("This draft was changed or discarded elsewhere.")).toBeInTheDocument();
    expect(action).toHaveBeenCalledTimes(1);
  });
});
