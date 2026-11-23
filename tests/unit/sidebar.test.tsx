import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Sidebar } from "@/components/app-shell/sidebar";

describe("Sidebar", () => {
  it("shows the clinic name and settings to owners", () => {
    render(<Sidebar role="owner" clinicName="Sunrise" />);
    expect(screen.getByText("Sunrise")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /settings/i })).toBeInTheDocument();
  });

  it("hides settings from reception but keeps patients", () => {
    render(<Sidebar role="reception" clinicName="Sunrise" />);
    expect(screen.queryByRole("link", { name: /settings/i })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /patients/i })).toBeInTheDocument();
  });

  it("hides patients and settings from accountants", () => {
    render(<Sidebar role="accountant" clinicName="Sunrise" />);
    expect(screen.queryByRole("link", { name: /patients/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /settings/i })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /dashboard/i })).toBeInTheDocument();
  });

  it("shows nothing sensitive for an unknown role", () => {
    render(<Sidebar role="mystery" clinicName="Sunrise" />);
    expect(screen.queryAllByRole("link")).toHaveLength(0);
  });

  it("gives doctors their profile but not clinic settings", () => {
    render(<Sidebar role="doctor" clinicName="Sunrise" />);
    expect(screen.getByRole("link", { name: /my profile/i })).toHaveAttribute("href", "/settings/profile");
    expect(screen.queryByRole("link", { name: /^settings$/i })).not.toBeInTheDocument();
  });

  it("shows a designer only the pad templates", () => {
    render(<Sidebar role="designer" clinicName="Sunrise" />);
    expect(screen.getAllByRole("link").map((link) => link.textContent)).toEqual(["Pad templates"]);
  });

  it("shows pad templates to owners and doctors, never to reception", () => {
    for (const role of ["owner", "doctor"]) {
      const { unmount } = render(<Sidebar role={role} clinicName="Sunrise" />);
      expect(screen.getByRole("link", { name: "Pad templates" })).toHaveAttribute("href", "/templates");
      unmount();
    }
    render(<Sidebar role="reception" clinicName="Sunrise" />);
    expect(screen.queryByRole("link", { name: "Pad templates" })).not.toBeInTheDocument();
  });
});
