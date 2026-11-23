import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh: vi.fn() }) }));

const createTemplateAction = vi.fn();
vi.mock("@/server/actions/templates", () => ({ createTemplateAction: (...args: unknown[]) => createTemplateAction(...args) }));

// The fake frame client: the real one needs a browser, a sandboxed iframe and pdf.js.
const rasterizePdfPage = vi.fn();
vi.mock("@/lib/templates/pdf-frame-client", () => ({ rasterizePdfPage: (...args: unknown[]) => rasterizePdfPage(...args) }));

const buildUploadImage = vi.fn();
const bitmaps: { width: number; height: number; close: ReturnType<typeof vi.fn> }[] = [];
const newBitmap = async () => {
  const bitmap = { width: 1654, height: 2339, close: vi.fn() };
  bitmaps.push(bitmap);
  return bitmap;
};
const fitted = (_b: unknown, _c: unknown, _t: unknown, target: { width: number; height: number }) => ({ width: target.width, height: target.height });
const loadBitmap = vi.fn(newBitmap);
const drawFitted = vi.fn(fitted);
vi.mock("@/lib/templates/canvas", () => ({
  loadBitmap: (...args: unknown[]) => (loadBitmap as (...a: unknown[]) => unknown)(...args),
  loadPreviewBitmap: vi.fn(async () => null),
  drawFitted: (...args: unknown[]) => (drawFitted as (...a: unknown[]) => unknown)(...args),
  buildUploadImage: (...args: unknown[]) => buildUploadImage(...args),
}));

const uploadBackground = vi.fn();
vi.mock("@/lib/templates/upload-client", () => ({ uploadBackground: (...args: unknown[]) => uploadBackground(...args) }));

import { NewTemplateWizard } from "@/components/templates/new-template-wizard";

const FILE_ID = "0190a0a0-0000-7000-8000-000000000001";

function pdfFile(name = "pad.pdf"): File {
  const file = new File([new Uint8Array([37, 80, 68, 70])], name, { type: "application/pdf" });
  Object.defineProperty(file, "arrayBuffer", { value: async () => new ArrayBuffer(4) });
  return file;
}

const ok = (over: Record<string, unknown> = {}) => ({ ok: true, image: new Blob([new Uint8Array([255, 216, 255])], { type: "image/jpeg" }), width: 1654, height: 2339, pageCount: 1, pageSizePt: [595.28, 841.89], nonWhitePercent: 12, ...over });

beforeEach(() => {
  vi.clearAllMocks();
  bitmaps.length = 0;
  loadBitmap.mockImplementation(newBitmap);
  drawFitted.mockImplementation(fitted);
  HTMLCanvasElement.prototype.getContext = (() => null) as unknown as HTMLCanvasElement["getContext"];
});

describe("NewTemplateWizard", () => {
  it("offers PDF and Word only when PDF intake is enabled", () => {
    const { unmount } = render(<NewTemplateWizard pdfEnabled />);
    expect(screen.getByRole("radio", { name: /^PDF/ })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Word file/ })).toBeInTheDocument();
    unmount();
    render(<NewTemplateWizard pdfEnabled={false} />);
    expect(screen.queryByRole("radio", { name: /^PDF/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: /Word file/ })).not.toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Photo or scan/ })).toBeInTheDocument();
  });

  it("asks for an image file for a photo, and explains Save as PDF for Word", () => {
    render(<NewTemplateWizard pdfEnabled />);
    fireEvent.click(screen.getByRole("radio", { name: /Photo or scan/ }));
    expect(screen.getByLabelText("Choose the photo or scan")).toHaveAttribute("accept", "image/png,image/jpeg");
    fireEvent.click(screen.getByRole("radio", { name: /Word file/ }));
    expect(screen.getByText(/File, Save As, PDF/, { selector: "p" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "I have the PDF" }));
    expect(screen.getByLabelText("Choose the PDF")).toHaveAttribute("accept", "application/pdf");
  });

  it("refuses an image over 15 MB before decoding it", () => {
    render(<NewTemplateWizard pdfEnabled />);
    fireEvent.click(screen.getByRole("radio", { name: /Photo or scan/ }));
    const big = new File([new Uint8Array(1)], "pad.jpg", { type: "image/jpeg" });
    Object.defineProperty(big, "size", { value: 16 * 1024 * 1024 });
    fireEvent.change(screen.getByLabelText("Choose the photo or scan"), { target: { files: [big] } });
    expect(screen.getByText(/larger than 15 MB/)).toBeInTheDocument();
  });

  it("falls back to an image upload when the sandboxed frame cannot read the PDF", async () => {
    rasterizePdfPage.mockResolvedValue({ ok: false, code: "timeout" });
    render(<NewTemplateWizard pdfEnabled />);
    fireEvent.click(screen.getByRole("radio", { name: /^PDF/ }));
    fireEvent.change(screen.getByLabelText("Choose the PDF"), { target: { files: [pdfFile()] } });
    expect(await screen.findByText(/took too long/)).toBeInTheDocument();
    expect(screen.getByText(/Export the pad page as a PNG or JPEG/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Use a photo or image instead" }));
    expect(screen.getByLabelText("Choose the photo or scan")).toBeInTheDocument();
  });

  it("explains an encrypted PDF without the file name", async () => {
    rasterizePdfPage.mockResolvedValue({ ok: false, code: "encrypted" });
    render(<NewTemplateWizard pdfEnabled />);
    fireEvent.click(screen.getByRole("radio", { name: /^PDF/ }));
    fireEvent.change(screen.getByLabelText("Choose the PDF"), { target: { files: [pdfFile("<img src=x onerror=alert(1)>.pdf")] } });
    expect(await screen.findByText(/password-protected/)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("onerror");
  });

  it("takes a PDF through the frame, fit, upload and creation, then opens the new pad", async () => {
    rasterizePdfPage.mockResolvedValue(ok());
    buildUploadImage.mockResolvedValue({ blob: new Blob([new Uint8Array([255, 216, 255])]), darkness: Array.from({ length: 100 }, (_, i) => (i < 15 ? 0.3 : 0.01)) });
    uploadBackground.mockResolvedValue({ ok: true, fileId: FILE_ID });
    createTemplateAction.mockResolvedValue({ ok: true, templateId: "t-1" });
    render(<NewTemplateWizard pdfEnabled />);
    fireEvent.click(screen.getByRole("radio", { name: /^PDF/ }));
    fireEvent.change(screen.getByLabelText("Choose the PDF"), { target: { files: [pdfFile()] } });
    expect(await screen.findByRole("heading", { name: "Fit the pad" })).toBeInTheDocument();
    expect(rasterizePdfPage).toHaveBeenCalledWith(expect.any(ArrayBuffer), { page: 1, dpi: 200 });
    expect(screen.getByText("The proportions fit an A4 or A5 pad.")).toBeInTheDocument();
    expect(screen.getByLabelText("Paper size of this pad")).toHaveValue("A4");
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByLabelText("Name of this pad")).toBeInTheDocument();
    expect(uploadBackground).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByLabelText("Name of this pad"), { target: { value: "Clinic pad" } });
    fireEvent.click(screen.getByRole("button", { name: "Place the boxes" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/templates/t-1"));
    const input = createTemplateAction.mock.calls[0][0] as { name: string; fileId: string; paperSize: string; labels: string; definition: { boxes: unknown[]; flow: { topMm: number } } };
    expect(input).toMatchObject({ name: "Clinic pad", fileId: FILE_ID, paperSize: "A4", labels: "en" });
    expect(input.definition.boxes.length).toBeGreaterThan(0);
    expect(input.definition.flow.topMm).toBeGreaterThan(40);
  });

  it("proposes A5 for an A5 PDF page and warns about a blank render", async () => {
    rasterizePdfPage.mockResolvedValue(ok({ pageSizePt: [419.53, 595.28], nonWhitePercent: 0 }));
    render(<NewTemplateWizard pdfEnabled />);
    fireEvent.click(screen.getByRole("radio", { name: /^PDF/ }));
    fireEvent.change(screen.getByLabelText("Choose the PDF"), { target: { files: [pdfFile()] } });
    expect(await screen.findByText(/looks blank/)).toBeInTheDocument();
    expect(screen.getByLabelText("Paper size of this pad")).toHaveValue("A5");
  });

  it("shows the server's friendly message when the upload is refused, and does not create a pad", async () => {
    rasterizePdfPage.mockResolvedValue(ok());
    buildUploadImage.mockResolvedValue({ blob: new Blob([new Uint8Array([255, 216, 255])]), darkness: [] });
    uploadBackground.mockResolvedValue({ ok: false, message: "The image file is damaged. Export it again as a PNG or JPEG." });
    render(<NewTemplateWizard pdfEnabled />);
    fireEvent.click(screen.getByRole("radio", { name: /^PDF/ }));
    fireEvent.change(screen.getByLabelText("Choose the PDF"), { target: { files: [pdfFile()] } });
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    expect(await screen.findByText(/image file is damaged/)).toBeInTheDocument();
    expect(createTemplateAction).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Name of this pad")).not.toBeInTheDocument();
  });

  it("keeps the wizard usable when creating the pad is refused", async () => {
    rasterizePdfPage.mockResolvedValue(ok());
    buildUploadImage.mockResolvedValue({ blob: new Blob([new Uint8Array([255, 216, 255])]), darkness: [] });
    uploadBackground.mockResolvedValue({ ok: true, fileId: FILE_ID });
    createTemplateAction.mockResolvedValue({ error: "You have reached the limit of 20 pad templates." });
    render(<NewTemplateWizard pdfEnabled />);
    fireEvent.click(screen.getByRole("radio", { name: /^PDF/ }));
    fireEvent.change(screen.getByLabelText("Choose the PDF"), { target: { files: [pdfFile()] } });
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    fireEvent.click(await screen.findByRole("button", { name: "Place the boxes" }));
    expect(await screen.findByText(/limit of 20 pad templates/)).toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Place the boxes" })).toBeEnabled();
  });

  describe("page selector, stale reads, busy states and bitmaps", () => {
    const pickPdf = async (over: Record<string, unknown> = {}) => {
      rasterizePdfPage.mockResolvedValue(ok({ pageCount: 3, ...over }));
      fireEvent.click(screen.getByRole("radio", { name: /^PDF/ }));
      fireEvent.change(screen.getByLabelText("Choose the PDF"), { target: { files: [pdfFile()] } });
      await screen.findByRole("heading", { name: "Fit the pad" });
    };

    it("lets the doctor pick another page of a multi-page PDF in the fit step, rasterizing that page from the same bytes", async () => {
      render(<NewTemplateWizard pdfEnabled />);
      await pickPdf();
      const select = screen.getByLabelText("The pad is on page");
      expect(select).toHaveValue("1");
      expect(within(select).getAllByRole("option").map((o) => o.textContent)).toEqual(["1 of 3", "2 of 3", "3 of 3"]);
      fireEvent.change(select, { target: { value: "3" } });
      await waitFor(() => expect(rasterizePdfPage).toHaveBeenCalledTimes(2));
      expect(rasterizePdfPage).toHaveBeenLastCalledWith(expect.any(ArrayBuffer), { page: 3, dpi: 200 });
      expect(rasterizePdfPage.mock.calls[1][0]).toBe(rasterizePdfPage.mock.calls[0][0]);
      await waitFor(() => expect(screen.getByLabelText("The pad is on page")).toHaveValue("3"));
      expect(bitmaps[0].close).toHaveBeenCalledTimes(1); // the replaced page's bitmap is released
      expect(bitmaps[1].close).not.toHaveBeenCalled();
    });

    it("shows no page selector for a one-page PDF", async () => {
      render(<NewTemplateWizard pdfEnabled />);
      await pickPdf({ pageCount: 1 });
      expect(screen.queryByLabelText("The pad is on page")).not.toBeInTheDocument();
    });

    it("keeps the current page and says why when another page cannot be read", async () => {
      render(<NewTemplateWizard pdfEnabled />);
      await pickPdf();
      rasterizePdfPage.mockResolvedValue({ ok: false, code: "timeout" });
      fireEvent.change(screen.getByLabelText("The pad is on page"), { target: { value: "2" } });
      expect(await screen.findByText(/took too long/)).toBeInTheDocument();
      expect(screen.getByRole("heading", { name: "Fit the pad" })).toBeInTheDocument();
      expect(bitmaps[0].close).not.toHaveBeenCalled();
    });

    it("locks the source choice while a file is read, and releases the bitmap when the doctor goes back", async () => {
      let finish: (value: unknown) => void = () => undefined;
      rasterizePdfPage.mockReturnValue(new Promise((resolve) => (finish = resolve)));
      render(<NewTemplateWizard pdfEnabled />);
      fireEvent.click(screen.getByRole("radio", { name: /^PDF/ }));
      fireEvent.change(screen.getByLabelText("Choose the PDF"), { target: { files: [pdfFile()] } });
      expect(screen.getByRole("radio", { name: /Photo or scan/ })).toBeDisabled();
      expect(screen.getByLabelText("Choose the PDF")).toBeDisabled();
      finish(ok());
      expect(await screen.findByRole("heading", { name: "Fit the pad" })).toBeInTheDocument();
      expect(screen.getByRole("radio", { name: /Photo or scan/ })).toBeEnabled();
      fireEvent.click(screen.getByRole("button", { name: "Choose another file" }));
      expect(screen.queryByRole("heading", { name: "Fit the pad" })).not.toBeInTheDocument();
      expect(bitmaps[0].close).toHaveBeenCalledTimes(1);
    });

    it("releases a decoded bitmap that arrives after a newer read took over, and shows only the newer one", async () => {
      let release: (value: unknown) => void = () => undefined;
      loadBitmap.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)) as never);
      rasterizePdfPage.mockResolvedValue(ok());
      render(<NewTemplateWizard pdfEnabled />);
      fireEvent.click(screen.getByRole("radio", { name: /^PDF/ }));
      fireEvent.change(screen.getByLabelText("Choose the PDF"), { target: { files: [pdfFile()] } });
      await waitFor(() => expect(loadBitmap).toHaveBeenCalledTimes(1));
      // the guard is the generation token (the real input is disabled while busy, but a second read must still never win late)
      fireEvent.change(screen.getByLabelText("Choose the PDF"), { target: { files: [pdfFile()] } });
      expect(await screen.findByRole("heading", { name: "Fit the pad" })).toBeInTheDocument();
      const late = { width: 1654, height: 2339, close: vi.fn() };
      release(late);
      await waitFor(() => expect(late.close).toHaveBeenCalledTimes(1));
      expect(bitmaps[0].close).not.toHaveBeenCalled(); // the newer bitmap stays on screen
    });

    it("locks the source choice and the Continue button while the pad image uploads", async () => {
      let done: (value: unknown) => void = () => undefined;
      buildUploadImage.mockResolvedValue({ blob: new Blob([new Uint8Array([255, 216, 255])]), darkness: [] });
      uploadBackground.mockReturnValue(new Promise((resolve) => (done = resolve)));
      render(<NewTemplateWizard pdfEnabled />);
      await pickPdf({ pageCount: 1 });
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
      expect(await screen.findByRole("button", { name: "Uploading…" })).toBeDisabled();
      expect(screen.getByRole("radio", { name: /Photo or scan/ })).toBeDisabled();
      done({ ok: true, fileId: FILE_ID });
      expect(await screen.findByLabelText("Name of this pad")).toBeInTheDocument();
    });

    it("stays busy after a successful creation, so a second click cannot create the pad twice", async () => {
      buildUploadImage.mockResolvedValue({ blob: new Blob([new Uint8Array([255, 216, 255])]), darkness: [] });
      uploadBackground.mockResolvedValue({ ok: true, fileId: FILE_ID });
      createTemplateAction.mockResolvedValue({ ok: true, templateId: "t-9" });
      render(<NewTemplateWizard pdfEnabled />);
      await pickPdf({ pageCount: 1 });
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
      const place = await screen.findByRole("button", { name: "Place the boxes" });
      fireEvent.click(place);
      await waitFor(() => expect(push).toHaveBeenCalledWith("/templates/t-9"));
      await waitFor(() => expect(screen.getByRole("button", { name: /Place the boxes|Creating/ })).toBeDisabled());
      expect(createTemplateAction).toHaveBeenCalledTimes(1);
    });

    it("shows a friendly message, not an uncaught error, when the preview cannot be drawn", async () => {
      drawFitted.mockImplementation(() => {
        throw new Error("canvas area exceeds the maximum limit");
      });
      render(<NewTemplateWizard pdfEnabled />);
      await pickPdf({ pageCount: 1 });
      expect(await screen.findByText(/preview could not be drawn in this browser/)).toBeInTheDocument();
      expect(screen.getByRole("heading", { name: "Fit the pad" })).toBeInTheDocument();
    });

    it("says so when a photo cannot be decoded", async () => {
      loadBitmap.mockRejectedValueOnce(new Error("decode"));
      render(<NewTemplateWizard pdfEnabled />);
      fireEvent.click(screen.getByRole("radio", { name: /Photo or scan/ }));
      fireEvent.change(screen.getByLabelText("Choose the photo or scan"), { target: { files: [new File([new Uint8Array(4)], "p.jpg", { type: "image/jpeg" })] } });
      expect(await screen.findByText(/could not be opened as an image/)).toBeInTheDocument();
    });
  });
});
