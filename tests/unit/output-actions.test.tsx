import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { OutputActions } from "@/components/rx/output-actions";

const ID = "00000000-0000-4000-8000-000000000001";

afterEach(() => {
  document.querySelectorAll("iframe").forEach((f) => f.remove());
  vi.unstubAllGlobals();
});

function frame(): HTMLIFrameElement {
  const found = document.querySelector<HTMLIFrameElement>('iframe[title="Prescription print frame"]');
  if (!found) throw new Error("no print frame");
  return found;
}

describe("OutputActions print", () => {
  it("loads the same-origin print document and prints only when it reports ready", () => {
    render(<OutputActions prescriptionId={ID} fileName="Rx-1-v1.pdf" />);
    fireEvent.click(screen.getByRole("button", { name: "Print" }));
    const f = frame();
    expect(f.getAttribute("src")).toBe(`/prescriptions/${ID}/document?purpose=print`);
    const print = vi.fn();
    Object.defineProperty(f, "contentWindow", { value: { focus: vi.fn(), print }, configurable: true });
    Object.defineProperty(f, "contentDocument", { value: { body: { dataset: { rx: "ready" } } }, configurable: true });
    fireEvent.load(f);
    expect(print).toHaveBeenCalledTimes(1);
  });

  it("shows the friendly message and does not print when the document reports an error", () => {
    render(<OutputActions prescriptionId={ID} fileName="Rx-1-v1.pdf" />);
    fireEvent.click(screen.getByRole("button", { name: "Print" }));
    const f = frame();
    const print = vi.fn();
    Object.defineProperty(f, "contentWindow", { value: { focus: vi.fn(), print }, configurable: true });
    Object.defineProperty(f, "contentDocument", {
      value: { body: { dataset: { rx: "error" }, textContent: " The pad could not be built. " } },
      configurable: true,
    });
    fireEvent.load(f);
    expect(print).not.toHaveBeenCalled();
    expect(screen.getByText("The pad could not be built.")).toBeInTheDocument();
  });

  it("does not print an unexpected response and never opens a popup", () => {
    const open = vi.fn();
    vi.stubGlobal("open", open);
    render(<OutputActions prescriptionId={ID} fileName="Rx-1-v1.pdf" />);
    fireEvent.click(screen.getByRole("button", { name: "Print" }));
    const f = frame();
    const print = vi.fn();
    Object.defineProperty(f, "contentWindow", { value: { focus: vi.fn(), print }, configurable: true });
    Object.defineProperty(f, "contentDocument", { value: { body: { dataset: {} } }, configurable: true });
    fireEvent.load(f);
    expect(print).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(screen.getByText(/could not be prepared for printing/)).toBeInTheDocument();
  });
});

describe("OutputActions download", () => {
  it("shows the service message when the PDF is refused", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ message: "The PDF service is not reachable." }), {
          status: 503,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    render(<OutputActions prescriptionId={ID} fileName="Rx-1-v1.pdf" />);
    fireEvent.click(screen.getByRole("button", { name: "Download PDF" }));
    await waitFor(() => expect(screen.getByText("The PDF service is not reachable.")).toBeInTheDocument());
  });

  it("reports an offline failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("network")));
    render(<OutputActions prescriptionId={ID} fileName="Rx-1-v1.pdf" />);
    fireEvent.click(screen.getByRole("button", { name: "Download PDF" }));
    await waitFor(() => expect(screen.getByText(/appear to be offline/)).toBeInTheDocument());
  });
});
