import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

const actions = vi.hoisted(() => ({ recordConsentAction: vi.fn(), withdrawConsentAction: vi.fn() }));
vi.mock("@/server/actions/consent", () => actions);

import { ConsentCard } from "@/components/patients/consent-card";
import { CONSENT_TEXT } from "@/lib/domain/consent";

const ID = "00000000-0000-4000-8000-0000000000a1";

beforeEach(() => {
  actions.recordConsentAction.mockReset();
  actions.withdrawConsentAction.mockReset();
});

describe("ConsentCard", () => {
  it("shows the exact consent text in English and Hindi and sends the method and the confirmation", async () => {
    actions.recordConsentAction.mockResolvedValue({ saved: true });
    render(<ConsentCard patientId={ID} consent={null} canCapture archived={false} timeZone="Asia/Kolkata" />);
    expect(screen.getByText("Not recorded. Nothing can be shared until the patient agrees.")).toBeInTheDocument();
    expect(screen.getByText(CONSENT_TEXT["sharing-v1"].en)).toBeInTheDocument();
    expect(screen.getByText(CONSENT_TEXT["sharing-v1"].hi)).toHaveAttribute("lang", "hi");
    fireEvent.click(screen.getByLabelText("Written"));
    fireEvent.click(screen.getByLabelText("The patient (or their guardian) agreed to this text."));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Record consent" }));
    });
    const [patientId, , formData] = actions.recordConsentAction.mock.calls[0] as [string, unknown, FormData];
    expect(patientId).toBe(ID);
    expect(formData.get("method")).toBe("written");
    expect(formData.get("confirmed")).toBe("yes");
    expect(formData.get("version")).toBe("sharing-v1");
  });

  it("withdraws only after the confirm step, with focus on Keep it", async () => {
    actions.withdrawConsentAction.mockResolvedValue({ saved: true });
    render(
      <ConsentCard
        patientId={ID}
        consent={{ id: "c", granted: true, version: "sharing-v1", method: "verbal", recordedAt: new Date("2026-11-16T19:00:00Z") }}
        canCapture
        archived={false}
        timeZone="Asia/Kolkata"
      />,
    );
    expect(screen.getByText("Given (verbal) on 17 Nov 2026.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Withdraw consent" }));
    expect(screen.getByRole("button", { name: "Keep it" })).toHaveFocus();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Yes, withdraw consent" }));
    });
    await waitFor(() => expect(actions.withdrawConsentAction).toHaveBeenCalledTimes(1));
    const [patientId, , formData] = actions.withdrawConsentAction.mock.calls[0] as [string, unknown, FormData];
    expect(patientId).toBe(ID);
    expect(formData.get("method")).toBe("verbal");
    // The confirm step closes once the request is sent.
    expect(screen.queryByRole("button", { name: "Yes, withdraw consent" })).toBeNull();
  });

  it("says when consent was withdrawn and offers the text again", () => {
    render(
      <ConsentCard
        patientId={ID}
        consent={{ id: "c", granted: false, version: "sharing-v1", method: "written", recordedAt: new Date("2026-11-16T19:00:00Z") }}
        canCapture
        archived={false}
        timeZone="Asia/Kolkata"
      />,
    );
    expect(screen.getByText("Withdrawn on 17 Nov 2026. Nothing can be shared until consent is recorded again.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Record consent" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Withdraw consent" })).toBeNull();
  });

  it("announces an action error as an alert tied to the form", async () => {
    actions.recordConsentAction.mockResolvedValue({ error: "Confirm that the patient agreed to the text above.", field: "confirmed" });
    render(<ConsentCard patientId={ID} consent={null} canCapture archived={false} timeZone="Asia/Kolkata" />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Record consent" }));
    });
    const alert = await screen.findByText("Confirm that the patient agreed to the text above.");
    expect(alert).toHaveAttribute("role", "alert");
    expect(screen.getByLabelText("The patient (or their guardian) agreed to this text.")).toHaveAttribute("aria-describedby", alert.id);
  });

  it("shows only the status to roles that cannot capture consent, and no record form for archived patients", () => {
    const first = render(<ConsentCard patientId={ID} consent={null} canCapture={false} archived={false} timeZone="Asia/Kolkata" />);
    expect(screen.queryByRole("button", { name: "Record consent" })).toBeNull();
    first.unmount();
    render(<ConsentCard patientId={ID} consent={null} canCapture archived timeZone="Asia/Kolkata" />);
    expect(screen.queryByRole("button", { name: "Record consent" })).toBeNull();
  });
});
