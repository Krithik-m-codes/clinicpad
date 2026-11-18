import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ClinicPadForm } from "@/components/settings/clinic-pad-form";
import { DoctorProfileForm } from "@/components/settings/doctor-profile-form";
import { SharingForm } from "@/components/settings/sharing-form";
import { ImageUploadForm } from "@/components/settings/image-upload-form";
import type { SettingsFormState } from "@/server/actions/settings";
import type { ClinicPadView, DoctorProfileView } from "@/server/services/pad-settings";

const actions = vi.hoisted(() => ({ saveClinicPadAction: vi.fn(), saveDoctorProfileAction: vi.fn(), saveSharingAction: vi.fn() }));
vi.mock("@/server/actions/settings", () => actions);

const CLINIC: ClinicPadView = {
  name: "Asha Clinic",
  addressLine1: "1 Main Road",
  addressLine2: "",
  city: "Pune",
  state: "MH",
  pincode: "411001",
  phone: "020 1234",
  email: "a@example.test",
  padFooter: "Mon to Sat",
  rxTemplate: "general",
  rxPaperSize: "A4",
  rxLabels: "en",
} as ClinicPadView;

const DOCTOR: DoctorProfileView = {
  displayName: "Dr Asha Rao",
  qualifications: "MBBS",
  designation: "Physician",
  registrationNo: "12345",
  registrationCouncil: "MMC",
} as DoctorProfileView;

const HOSTILE = '<img src=x onerror=alert(1)> "quoted" &amp; आशा </textarea><script>alert(2)</script>';

beforeEach(() => {
  actions.saveClinicPadAction.mockReset();
  actions.saveDoctorProfileAction.mockReset();
});

describe("ClinicPadForm", () => {
  it("shows the saved values and clears Saved. on the first edit", async () => {
    actions.saveClinicPadAction.mockResolvedValue({ saved: true } satisfies SettingsFormState);
    render(<ClinicPadForm initial={CLINIC} />);
    expect(screen.getByLabelText("Clinic name")).toHaveValue("Asha Clinic");
    expect(screen.getByLabelText("Footer lines")).toHaveValue("Mon to Sat");
    fireEvent.click(screen.getByRole("button", { name: "Save pad" }));
    await waitFor(() => expect(screen.getByText("Saved.")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("City"), { target: { value: "Mumbai" } });
    expect(screen.queryByText("Saved.")).toBeNull();
  });

  it("round-trips hostile text as text: echoed into the field, error shown, nothing injected", async () => {
    actions.saveClinicPadAction.mockImplementation(async (_prev: SettingsFormState, formData: FormData) => ({
      error: `Clinic name has a problem: ${HOSTILE}`,
      field: "name",
      values: { name: String(formData.get("name")), padFooter: String(formData.get("padFooter")), rxTemplate: "general", rxPaperSize: "A4", rxLabels: "en" },
    }));
    const { container } = render(<ClinicPadForm initial={CLINIC} />);
    fireEvent.change(screen.getByLabelText("Clinic name"), { target: { value: HOSTILE } });
    fireEvent.change(screen.getByLabelText("Footer lines"), { target: { value: HOSTILE } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save pad" }));
    });
    await waitFor(() => expect(screen.getByText(/Clinic name has a problem/)).toBeInTheDocument());
    expect(screen.getByLabelText("Clinic name")).toHaveValue(HOSTILE);
    expect(screen.getByLabelText("Footer lines")).toHaveValue(HOSTILE);
    expect(screen.getByLabelText("Clinic name")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText(/Clinic name has a problem/).textContent).toContain(HOSTILE);
    expect(container.querySelector("img, script")).toBeNull();
    expect(screen.queryByText("Saved.")).toBeNull();
  });
});

describe("DoctorProfileForm", () => {
  it("shows the saved values and clears Saved. on the first edit", async () => {
    actions.saveDoctorProfileAction.mockResolvedValue({ saved: true } satisfies SettingsFormState);
    render(<DoctorProfileForm initial={DOCTOR} />);
    expect(screen.getByLabelText("Registration number")).toHaveValue("12345");
    fireEvent.click(screen.getByRole("button", { name: "Save profile" }));
    await waitFor(() => expect(screen.getByText("Saved.")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("Qualifications"), { target: { value: "MD" } });
    expect(screen.queryByText("Saved.")).toBeNull();
  });

  it("round-trips hostile text as text", async () => {
    actions.saveDoctorProfileAction.mockImplementation(async (_prev: SettingsFormState, formData: FormData) => ({
      error: "Name on prescriptions is not valid.",
      field: "displayName",
      values: { displayName: String(formData.get("displayName")) },
    }));
    const { container } = render(<DoctorProfileForm initial={DOCTOR} />);
    fireEvent.change(screen.getByLabelText("Name on prescriptions"), { target: { value: HOSTILE } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save profile" }));
    });
    await waitFor(() => expect(screen.getByText("Name on prescriptions is not valid.")).toBeInTheDocument());
    expect(screen.getByLabelText("Name on prescriptions")).toHaveValue(HOSTILE);
    expect(screen.getByLabelText("Name on prescriptions")).toHaveAttribute("aria-invalid", "true");
    expect(container.querySelector("img, script")).toBeNull();
  });
});

describe("ImageUploadForm status messages", () => {
  function setup(upload: (prev: SettingsFormState, fd: FormData) => Promise<SettingsFormState>, remove: () => Promise<SettingsFormState>) {
    const current = { id: "a", dataUrl: "data:image/png;base64,AAAA", width: 200, height: 60 };
    render(<ImageUploadForm label="Clinic logo" hint="PNG or JPEG" current={current} upload={upload} remove={remove} />);
    return screen.getByLabelText("Clinic logo") as HTMLInputElement;
  }
  const png = () => new File([new Uint8Array(10)], "logo.png", { type: "image/png" });

  it("says Image saved. after an upload and a distinct Image removed. after a removal, never both", async () => {
    const input = setup(async () => ({ saved: true }), async () => ({ saved: true }));
    fireEvent.change(input, { target: { files: [png()] } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Upload" }));
    });
    await waitFor(() => expect(screen.getByText("Image saved.")).toBeInTheDocument());
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    });
    await waitFor(() => expect(screen.getByText("Image removed.")).toBeInTheDocument());
    expect(screen.queryByText("Image saved.")).toBeNull();
  });

  it("drops a stale upload error after a successful removal", async () => {
    const input = setup(async () => ({ error: "That image could not be read.", field: "image" }), async () => ({ saved: true }));
    fireEvent.change(input, { target: { files: [png()] } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Upload" }));
    });
    await waitFor(() => expect(screen.getByText("That image could not be read.")).toBeInTheDocument());
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    });
    await waitFor(() => expect(screen.getByText("Image removed.")).toBeInTheDocument());
    expect(screen.queryByText("That image could not be read.")).toBeNull();
  });

  it("shows a removal error and no stale saved message", async () => {
    const input = setup(async () => ({ saved: true }), async () => ({ error: "Could not remove it." }));
    fireEvent.change(input, { target: { files: [png()] } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Upload" }));
    });
    await waitFor(() => expect(screen.getByText("Image saved.")).toBeInTheDocument());
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    });
    await waitFor(() => expect(screen.getByText("Could not remove it.")).toBeInTheDocument());
    expect(screen.queryByText("Image saved.")).toBeNull();
  });

  it("clears the server error when a new file is picked", async () => {
    const input = setup(async () => ({ error: "That image could not be read.", field: "image" }), async () => ({}));
    fireEvent.change(input, { target: { files: [png()] } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Upload" }));
    });
    await waitFor(() => expect(screen.getByText("That image could not be read.")).toBeInTheDocument());
    fireEvent.change(input, { target: { files: [png()] } });
    expect(screen.queryByText("That image could not be read.")).toBeNull();
    expect(input).not.toHaveAttribute("aria-invalid");
  });

  it("marks the file input invalid and described by the message", async () => {
    const input = setup(async () => ({}), async () => ({}));
    expect(input).not.toHaveAttribute("aria-invalid");
    expect(input).not.toHaveAttribute("aria-describedby");
    fireEvent.change(input, { target: { files: [new File(["<svg/>"], "logo.svg", { type: "image/svg+xml" })] } });
    expect(input).toHaveAttribute("aria-invalid", "true");
    const message = screen.getByRole("alert");
    expect(input.getAttribute("aria-describedby")).toBe(message.id);
    expect(message.id).not.toBe("");
  });
});

describe("SharingForm", () => {
  it("sends the switch state and confirms the save", async () => {
    actions.saveSharingAction.mockResolvedValue({ saved: true } satisfies SettingsFormState);
    render(<SharingForm enabled={false} />);
    fireEvent.click(screen.getByRole("checkbox"));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save sharing" }));
    });
    const formData = actions.saveSharingAction.mock.calls[0][1] as FormData;
    expect(formData.get("sharingEnabled")).toBe("on");
    await waitFor(() => expect(screen.getByText("Saved.")).toBeInTheDocument());
  });
});
