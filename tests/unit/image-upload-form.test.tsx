import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ImageUploadForm, checkImageFile } from "@/components/settings/image-upload-form";

function setup() {
  const upload = vi.fn(async () => ({ saved: true }));
  const remove = vi.fn(async () => ({ saved: true }));
  render(<ImageUploadForm label="Clinic logo" hint="PNG or JPEG" current={null} upload={upload} remove={remove} />);
  return { upload, remove, input: screen.getByLabelText("Clinic logo") as HTMLInputElement };
}

describe("checkImageFile", () => {
  it.each([
    [{ size: 1000, type: "image/png" }, null],
    [{ size: 1000, type: "image/jpeg" }, null],
    [{ size: 512 * 1024, type: "image/png" }, null],
    [{ size: 1000, type: "image/svg+xml" }, "Choose a PNG or JPEG image."],
    [{ size: 1000, type: "" }, "Choose a PNG or JPEG image."],
    [{ size: 600 * 1024, type: "image/png" }, "The image is larger than 512 KB."],
    [{ size: 512 * 1024 + 1, type: "image/png" }, "The image is larger than 512 KB."],
  ])("checks %j", (file, expected) => {
    expect(checkImageFile(file)).toBe(expected);
  });
});

describe("ImageUploadForm", () => {
  it("blocks an oversized file before it is sent", () => {
    const { input, upload } = setup();
    fireEvent.change(input, { target: { files: [new File([new Uint8Array(600 * 1024)], "big.png", { type: "image/png" })] } });
    expect(screen.getByRole("alert")).toHaveTextContent("larger than 512 KB");
    expect(screen.getByRole("button", { name: "Upload" })).toBeDisabled();
    expect(upload).not.toHaveBeenCalled();
  });

  it("blocks an SVG", () => {
    const { input } = setup();
    fireEvent.change(input, { target: { files: [new File(["<svg/>"], "logo.svg", { type: "image/svg+xml" })] } });
    expect(screen.getByRole("alert")).toHaveTextContent("PNG or JPEG");
  });

  it("allows a small PNG and says there is no image yet", () => {
    const { input } = setup();
    fireEvent.change(input, { target: { files: [new File([new Uint8Array(10)], "logo.png", { type: "image/png" })] } });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "Upload" })).toBeEnabled();
    expect(screen.getByText("No image yet.")).toBeInTheDocument();
  });

  it("never shows the client file name", () => {
    const { input } = setup();
    fireEvent.change(input, { target: { files: [new File([new Uint8Array(600 * 1024)], "secret-name.png", { type: "image/png" })] } });
    expect(screen.queryByText(/secret-name/)).toBeNull();
  });

  it("shows the current image with a remove button", () => {
    render(
      <ImageUploadForm
        label="Signature"
        hint="PNG or JPEG"
        current={{ id: "a", dataUrl: "data:image/png;base64,AAAA", width: 200, height: 60 }}
        upload={vi.fn(async () => ({}))}
        remove={vi.fn(async () => ({}))}
      />,
    );
    expect(screen.getByRole("img", { name: "Current signature" })).toHaveAttribute("src", "data:image/png;base64,AAAA");
    expect(screen.getByRole("button", { name: "Remove" })).toBeInTheDocument();
  });
});
