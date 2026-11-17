import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { SharePanelData } from "@/server/services/sharing";

const actions = vi.hoisted(() => ({
  shareWhatsAppAction: vi.fn(),
  shareEmailAction: vi.fn(),
  revokeShareLinkAction: vi.fn(),
  recordConsentAction: vi.fn(),
  withdrawConsentAction: vi.fn(),
}));
vi.mock("@/server/actions/sharing", () => ({
  shareWhatsAppAction: actions.shareWhatsAppAction,
  shareEmailAction: actions.shareEmailAction,
  revokeShareLinkAction: actions.revokeShareLinkAction,
}));
vi.mock("@/server/actions/consent", () => ({ recordConsentAction: actions.recordConsentAction, withdrawConsentAction: actions.withdrawConsentAction }));

import { SharePanel } from "@/components/rx/share-panel";

const RX = "00000000-0000-4000-8000-0000000000b1";
const LINK = "00000000-0000-4000-8000-0000000000c1";
const data = (overrides: Partial<SharePanelData> = {}): SharePanelData => ({
  prescriptionId: RX,
  patientId: "00000000-0000-4000-8000-0000000000d1",
  status: "finalized",
  enabled: true,
  consent: { id: "c", granted: true, version: "sharing-v1", method: "verbal", recordedAt: new Date("2026-11-16T05:00:00Z") },
  links: [],
  emailAvailable: false,
  defaultPhone: "98765 43210",
  timeZone: "Asia/Kolkata",
  archived: false,
  ...overrides,
});
const WA = "https://wa.me/919876543210?text=Asha%20Clinic";

beforeEach(() => {
  for (const fn of Object.values(actions)) fn.mockReset();
});

describe("SharePanel", () => {
  it("tells the owner where to turn sharing on, and everyone else whom to ask", () => {
    const first = render(<SharePanel data={data({ enabled: false })} canCaptureConsent isOwner />);
    expect(screen.getByRole("link", { name: "Turn it on in Settings" })).toHaveAttribute("href", "/settings");
    first.unmount();
    render(<SharePanel data={data({ enabled: false })} canCaptureConsent isOwner={false} />);
    expect(screen.getByText(/Ask the clinic owner to turn it on/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create WhatsApp message" })).toBeNull();
  });

  it("asks for consent before offering any way to share", () => {
    render(<SharePanel data={data({ consent: null })} canCaptureConsent isOwner={false} />);
    expect(screen.getByRole("button", { name: "Record consent" })).toBeInTheDocument();
    expect(screen.queryByLabelText("WhatsApp number")).toBeNull();
  });

  it("prepares the message, then opens WhatsApp only from a real link click (no popup-blocked window.open)", async () => {
    actions.shareWhatsAppAction.mockResolvedValue({ waUrl: WA, url: "https://app.test/s/T", sentTo: "+91******3210", expiresAt: "2026-11-24T05:00:00.000Z" });
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    render(<SharePanel data={data()} canCaptureConsent isOwner={false} />);
    expect(screen.getByLabelText("WhatsApp number")).toHaveValue("98765 43210");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create WhatsApp message" }));
    });
    const [prescriptionId, , formData] = actions.shareWhatsAppAction.mock.calls[0] as [string, unknown, FormData];
    expect(prescriptionId).toBe(RX);
    expect(formData.get("phone")).toBe("98765 43210");
    const open = await screen.findByRole("link", { name: "Open WhatsApp" });
    expect(open).toHaveAttribute("href", WA);
    expect(open).toHaveAttribute("target", "_blank");
    expect(open).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.getByText(/Message ready for \+91\*\*\*\*\*\*3210/)).toBeInTheDocument();
    expect(screen.getByLabelText("Share link")).toHaveValue("https://app.test/s/T");
    expect(openSpy).not.toHaveBeenCalled();
  });

  it("copies the link when the clipboard is available", async () => {
    actions.shareWhatsAppAction.mockResolvedValue({ waUrl: WA, url: "https://app.test/s/T", sentTo: "+91******3210", expiresAt: "2026-11-24T05:00:00.000Z" });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<SharePanel data={data()} canCaptureConsent isOwner={false} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create WhatsApp message" }));
    });
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: "Copy link" }));
    });
    expect(writeText).toHaveBeenCalledWith("https://app.test/s/T");
    expect(screen.getByRole("button", { name: "Link copied" })).toBeInTheDocument();
  });

  it("shows the error next to the number", async () => {
    actions.shareWhatsAppAction.mockResolvedValue({ error: "Add the country code, for example +44 7700 900123.", field: "phone" });
    render(<SharePanel data={data()} canCaptureConsent isOwner={false} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create WhatsApp message" }));
    });
    expect(await screen.findByText("Add the country code, for example +44 7700 900123.")).toBeInTheDocument();
    expect(screen.getByLabelText("WhatsApp number")).toHaveAttribute("aria-invalid", "true");
  });

  it("offers email only when it is set up", async () => {
    const first = render(<SharePanel data={data()} canCaptureConsent isOwner={false} />);
    expect(screen.getByText("Email sharing is not set up on this server.")).toBeInTheDocument();
    first.unmount();
    actions.shareEmailAction.mockResolvedValue({ sentTo: "a***@example.com", expiresAt: "2026-11-24T05:00:00.000Z" });
    render(<SharePanel data={data({ emailAvailable: true })} canCaptureConsent isOwner={false} />);
    fireEvent.change(screen.getByLabelText("Email address"), { target: { value: "asha@example.com" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send by email" }));
    });
    expect(await screen.findByText(/Sent to a\*\*\*@example.com/)).toBeInTheDocument();
  });

  it("shows the archived state instead of the forms, but keeps the links list", () => {
    render(<SharePanel data={data({ archived: true })} canCaptureConsent isOwner />);
    expect(screen.getByText(/patient is archived/i)).toBeInTheDocument();
    expect(screen.queryByLabelText("WhatsApp number")).toBeNull();
    expect(screen.queryByRole("button", { name: "Record consent" })).toBeNull();
  });

  it("does not offer to share a superseded version", () => {
    render(<SharePanel data={data({ status: "amended" })} canCaptureConsent isOwner />);
    expect(screen.getByText(/replaced by a newer one/)).toBeInTheDocument();
    expect(screen.queryByLabelText("WhatsApp number")).toBeNull();
  });

  it("lists links with their state and lets an active one be withdrawn", async () => {
    actions.revokeShareLinkAction.mockResolvedValue({});
    const links = [
      { id: LINK, channel: "whatsapp" as const, recipientMasked: "+91******3210", createdAt: new Date("2026-11-16T05:00:00Z"), expiresAt: new Date("2026-11-23T05:00:00Z"), openCount: 2, maxOpens: 10, status: "active" as const, revokeReason: null },
      { id: "00000000-0000-4000-8000-0000000000c2", channel: "email" as const, recipientMasked: "a***@example.com", createdAt: new Date("2026-11-15T05:00:00Z"), expiresAt: new Date("2026-11-22T05:00:00Z"), openCount: 0, maxOpens: 10, status: "revoked" as const, revokeReason: "consent_withdrawn" },
    ];
    render(<SharePanel data={data({ links })} canCaptureConsent isOwner={false} />);
    const items = within(screen.getByRole("list", { name: "Links sent" })).getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("WhatsApp to +91******3210");
    expect(items[0]).toHaveTextContent("opened 2 of 10");
    expect(items[1]).toHaveTextContent("withdrawn (consent withdrawn)");
    expect(within(items[1]).queryByRole("button", { name: "Withdraw link" })).toBeNull();
    await act(async () => {
      fireEvent.click(within(items[0]).getByRole("button", { name: "Withdraw link" }));
    });
    expect(actions.revokeShareLinkAction.mock.calls[0].slice(0, 2)).toEqual([RX, LINK]);
  });
});
