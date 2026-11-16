import { expect, test } from "@playwright/test";
import { cleanupClinic, registerClinic, type Clinic } from "./helpers";

let clinic: Clinic;

test.afterAll(async () => {
  if (clinic) await cleanupClinic(clinic.email);
});

test("register, find, warn on duplicate phone, and edit a patient", async ({ page }) => {
  clinic = await registerClinic(page, "pat");

  // Empty state.
  await page.getByRole("link", { name: "Patients" }).click();
  await expect(page.getByText(/no patients yet/i)).toBeVisible();

  // Register.
  await page.getByRole("link", { name: /new patient/i }).click();
  await page.getByLabel("Name").fill("Asha Rao");
  await page.getByLabel("Phone").fill("+91 98765 43210");
  await page.getByLabel("Gender").selectOption("female");
  await page.getByLabel("Date of birth").fill("1990-04-02");
  await page.getByLabel("Allergies").fill("Penicillin, Sulfa");
  await page.getByRole("button", { name: /register patient/i }).click();
  await expect(page).toHaveURL(/\/patients\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { name: "Asha Rao" })).toBeVisible();
  await expect(page.getByText("Penicillin")).toBeVisible();

  // Duplicate phone in another format -> warning, then confirm.
  await page.goto("/patients/new");
  await page.getByLabel("Name").fill("Meera Rao");
  await page.getByLabel("Phone").fill("9876543210");
  await page.getByRole("button", { name: /register patient/i }).click();
  await expect(page.getByText(/already exists/i)).toBeVisible();
  await expect(page.getByRole("link", { name: /Asha Rao/ })).toBeVisible();
  await page.getByRole("button", { name: /register anyway/i }).click();
  await expect(page.getByRole("heading", { name: "Meera Rao" })).toBeVisible();

  // Search by phone finds both; unknown term shows the no-match state.
  await page.goto("/patients?q=98765");
  await expect(page.getByRole("link", { name: "Asha Rao" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Meera Rao" })).toBeVisible();
  await page.goto("/patients?q=zzzz");
  await expect(page.getByText(/no patients match/i)).toBeVisible();

  // Edit.
  await page.goto("/patients?q=Meera");
  await page.getByRole("link", { name: "Meera Rao" }).click();
  await page.getByLabel("Name").fill("Meera Shah");
  await page.getByRole("button", { name: /save changes/i }).click();
  await expect(page.getByRole("heading", { name: "Meera Shah" })).toBeVisible();

  // A server-side validation error is shown inline and keeps what was typed.
  await page.getByLabel("Date of birth").fill("2999-01-01");
  await page.getByRole("button", { name: /save changes/i }).click();
  await expect(page.getByText(/cannot be in the future/i)).toBeVisible();
  await expect(page.getByLabel("Name")).toHaveValue("Meera Shah");

  // A malformed id is a clean 404, not a crash.
  await page.goto("/patients/not-a-uuid");
  await expect(page.getByText(/could not be found/i)).toBeVisible();
});
