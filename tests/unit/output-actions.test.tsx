import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { OutputActions } from "@/components/rx/output-actions";

const refresh = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

const ID = "00000000-0000-4000-8000-000000000001";
const FRAME = 'iframe[title="Prescription print frame"]';

beforeEach(() => {
  refresh.mockClear();
});

afterEach(() => {
  document.querySelectorAll("iframe").forEach((f) => f.remove());
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function frame(): HTMLIFrameElement {
  const found = document.querySelector<HTMLIFrameElement>(FRAME);
  if (!found) throw new Error("no print frame");
  return found;
}

function fake(f: HTMLIFrameElement, doc: unknown, print = vi.fn()) {
  Object.defineProperty(f, "contentWindow", { value: { focus: vi.fn(), print, addEventListener: vi.fn() }, configurable: true });
  Object.defineProperty(f, "contentDocument", { value: doc, configurable: true });
  return print;
}

const ready = { body: { dataset: { rx: "ready" } } };

describe("OutputActions print", () => {
  it("loads the same-origin print document and prints only when it reports ready", async () => {
    render(<OutputActions prescriptionId={ID} fileName="Rx-1-v1.pdf" />);
    fireEvent.click(screen.getByRole("button", { name: "Print" }));
    const f = frame();
    expect(f.getAttribute("src")).toBe(`/prescriptions/${ID}/document?purpose=print`);
    expect(f.tabIndex).toBe(-1);
    const print = fake(f, ready);
    fireEvent.load(f);
    await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(document.querySelector(FRAME)).toBeNull();
    expect(screen.getByRole("button", { name: "Print" })).toHaveFocus();
  });

  it("waits for fonts before printing", async () => {
    render(<OutputActions prescriptionId={ID} fileName="Rx-1-v1.pdf" />);
    fireEvent.click(screen.getByRole("button", { name: "Print" }));
    const f = frame();
    let release: () => void = () => {};
    const fonts = { ready: new Promise<void>((resolve) => (release = resolve)) };
    const print = fake(f, { ...ready, fonts });
    fireEvent.load(f);
    await Promise.resolve();
    expect(print).not.toHaveBeenCalled();
    await act(async () => release());
    await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
  });

  it("shows the friendly message and does not print when the document reports an error", () => {
    render(<OutputActions prescriptionId={ID} fileName="Rx-1-v1.pdf" />);
    fireEvent.click(screen.getByRole("button", { name: "Print" }));
    const f = frame();
    const print = fake(f, { body: { dataset: { rx: "error" }, textContent: " The pad could not be built. " } });
    fireEvent.load(f);
    expect(print).not.toHaveBeenCalled();
    expect(screen.getByText("The pad could not be built.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Print" })).toBeEnabled();
  });

  it("does not print an unexpected response and never opens a popup", () => {
    const open = vi.fn();
    vi.stubGlobal("open", open);
    render(<OutputActions prescriptionId={ID} fileName="Rx-1-v1.pdf" />);
    fireEvent.click(screen.getByRole("button", { name: "Print" }));
    const f = frame();
    const print = fake(f, { body: { dataset: {} } });
    fireEvent.load(f);
    expect(print).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(screen.getByText(/could not be prepared for printing/)).toBeInTheDocument();
  });

  it("treats a null contentDocument as a failure", () => {
    render(<OutputActions prescriptionId={ID} fileName="Rx-1-v1.pdf" />);
    fireEvent.click(screen.getByRole("button", { name: "Print" }));
    const f = frame();
    const print = fake(f, null);
    fireEvent.load(f);
    expect(print).not.toHaveBeenCalled();
    expect(screen.getByText(/could not be prepared for printing/)).toBeInTheDocument();
  });

  it("disables both buttons while preparing", () => {
    render(<OutputActions prescriptionId={ID} fileName="Rx-1-v1.pdf" />);
    fireEvent.click(screen.getByRole("button", { name: "Print" }));
    expect(screen.getByRole("button", { name: "Preparing…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Download PDF" })).toBeDisabled();
  });

  it("removes the frame and never prints when unmounted before load", async () => {
    const { unmount } = render(<OutputActions prescriptionId={ID} fileName="Rx-1-v1.pdf" />);
    fireEvent.click(screen.getByRole("button", { name: "Print" }));
    const f = frame();
    const print = fake(f, ready);
    unmount();
    expect(document.body.contains(f)).toBe(false);
    fireEvent.load(f);
    await Promise.resolve();
    expect(print).not.toHaveBeenCalled();
  });

  it("removes the previous frame when printing again", () => {
    render(<OutputActions prescriptionId={ID} fileName="Rx-1-v1.pdf" />);
    fireEvent.click(screen.getByRole("button", { name: "Print" }));
    const first = frame();
    fake(first, { body: { dataset: {} } });
    fireEvent.load(first);
    fireEvent.click(screen.getByRole("button", { name: "Print" }));
    expect(document.body.contains(first)).toBe(false);
    expect(document.querySelectorAll(FRAME)).toHaveLength(1);
  });

  it("gives up after the timeout with the failure message and re-enables the buttons", () => {
    vi.useFakeTimers();
    render(<OutputActions prescriptionId={ID} fileName="Rx-1-v1.pdf" />);
    fireEvent.click(screen.getByRole("button", { name: "Print" }));
    const f = frame();
    act(() => {
      vi.advanceTimersByTime(21_000);
    });
    expect(screen.getByText(/could not be prepared for printing/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Print" })).toBeEnabled();
    expect(document.body.contains(f)).toBe(false);
  });
});

describe("OutputActions download", () => {
  it("downloads the PDF under the file name and revokes the blob URL", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("%PDF-1.7", { status: 200, headers: { "content-type": "application/pdf" } })),
    );
    const create = vi.fn().mockReturnValue("blob:fake-url");
    const revoke = vi.fn();
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke }));
    const downloads: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      downloads.push(`${this.download}|${this.href}`);
    });
    render(<OutputActions prescriptionId={ID} fileName="Rx-1-v1.pdf" />);
    fireEvent.click(screen.getByRole("button", { name: "Download PDF" }));
    await waitFor(() => expect(downloads).toEqual(["Rx-1-v1.pdf|blob:fake-url"]));
    expect(create).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    act(() => {
      vi.advanceTimersByTime(31_000);
    });
    expect(revoke).toHaveBeenCalledWith("blob:fake-url");
    expect(screen.getByRole("button", { name: "Download PDF" })).toBeEnabled();
  });

  it("shows the service message when the PDF is refused", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ message: "The PDF service is not available right now." }), {
          status: 503,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    render(<OutputActions prescriptionId={ID} fileName="Rx-1-v1.pdf" />);
    fireEvent.click(screen.getByRole("button", { name: "Download PDF" }));
    await waitFor(() => expect(screen.getByText("The PDF service is not available right now.")).toBeInTheDocument());
    expect(refresh).not.toHaveBeenCalled();
  });

  it("says the session ended only for a redirect to the login page", async () => {
    const redirected = new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } });
    Object.defineProperty(redirected, "redirected", { value: true });
    Object.defineProperty(redirected, "url", { value: "http://localhost/login?next=%2Fx" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(redirected));
    render(<OutputActions prescriptionId={ID} fileName="Rx-1-v1.pdf" />);
    fireEvent.click(screen.getByRole("button", { name: "Download PDF" }));
    await waitFor(() => expect(screen.getByText(/session ended/)).toBeInTheDocument());
  });

  it("shows a generic failure for any other HTML response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("<html>oops</html>", { status: 500, headers: { "content-type": "text/html" } })),
    );
    render(<OutputActions prescriptionId={ID} fileName="Rx-1-v1.pdf" />);
    fireEvent.click(screen.getByRole("button", { name: "Download PDF" }));
    await waitFor(() => expect(screen.getByText(/could not be downloaded/)).toBeInTheDocument());
    expect(screen.queryByText(/session ended/)).toBeNull();
  });

  it("disables both buttons while generating", () => {
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));
    render(<OutputActions prescriptionId={ID} fileName="Rx-1-v1.pdf" />);
    fireEvent.click(screen.getByRole("button", { name: "Download PDF" }));
    expect(screen.getByRole("button", { name: "Generating PDF…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Print" })).toBeDisabled();
  });

  it("reports an offline failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("network")));
    render(<OutputActions prescriptionId={ID} fileName="Rx-1-v1.pdf" />);
    fireEvent.click(screen.getByRole("button", { name: "Download PDF" }));
    await waitFor(() => expect(screen.getByText(/appear to be offline/)).toBeInTheDocument());
  });
});
