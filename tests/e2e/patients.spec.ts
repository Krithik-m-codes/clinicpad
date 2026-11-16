import { expect, test, type Page } from "@playwright/test";
import { cleanupClinic, registerClinic, seedPatients, setRole, type Clinic } from "./helpers";

const clinics: Clinic[] = [];

test.afterAll(async () => {
  for (const clinic of clinics) await cleanupClinic(clinic.email);
});

async function newClinic(page: Page, label: string): Promise<Clinic> {
  const clinic = await registerClinic(page, label);
  clinics.push(clinic);
  return clinic;
}

async function registerAsha(page: Page): Promise<void> {
  await page.goto("/patients/new");
  await page.getByLabel("Name").fill("Asha Rao");
  await page.getByLabel("Phone").fill("+91 98765 43210");
  await page.getByLabel("Gender").selectOption("female");
  await page.getByLabel("Date of birth").fill("1990-04-02");
  await page.getByLabel("Allergies").fill("Penicillin, Sulfa");
  await page.getByRole("button", { name: /register patient/i }).click();
  await expect(page).toHaveURL(/\/patients\/[0-9a-f-]{36}$/);
}

test("register, find, warn on duplicate phone, and edit a patient", async ({ page }) => {
  await newClinic(page, "pat");

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

  // Edit Asha (who has a DOB and allergies), changing only the name: the form submits the full
  // record, so allergies, DOB and gender must survive the save.
  await page.goto("/patients?q=Asha");
  await page.getByRole("link", { name: "Asha Rao" }).click();
  await page.getByLabel("Name").fill("Asha Nair");
  await page.getByRole("button", { name: /save changes/i }).click();
  await expect(page.getByRole("heading", { name: "Asha Nair" })).toBeVisible();
  await expect(page.getByText("Penicillin, Sulfa")).toBeVisible();
  await expect(page.getByText(/\d+ y · female/)).toBeVisible();
  await expect(page.getByLabel("Date of birth")).toHaveValue("1990-04-02");

  // A server-side validation error is shown inline, keeps what was typed and focuses the field.
  await page.getByLabel("Date of birth").fill("2999-01-01");
  await page.getByRole("button", { name: /save changes/i }).click();
  await expect(page.getByText(/cannot be in the future/i)).toBeVisible();
  await expect(page.getByLabel("Name")).toHaveValue("Asha Nair");
  await expect(page.getByLabel("Date of birth")).toBeFocused();

  // A malformed id is a clean 404, not a crash.
  await page.goto("/patients/not-a-uuid");
  await expect(page.getByText(/could not be found/i)).toBeVisible();
});

test("the duplicate confirmation is explicit and re-checked after edits", async ({ page }) => {
  await newClinic(page, "dup");
  await registerAsha(page);

  await page.goto("/patients/new");
  await page.getByLabel("Name").fill("Meera Rao");
  await page.getByLabel("Phone").fill("9876543210");
  await page.getByRole("button", { name: /register patient/i }).click();
  await expect(page.getByText(/already exists/i)).toBeVisible();
  await expect(page.getByRole("button", { name: /register anyway/i })).toBeVisible();

  // Enter in a field submits the form's default (non-confirming) button: still warned, nothing saved.
  await Promise.all([
    page.waitForResponse((r) => r.request().method() === "POST"),
    page.getByLabel("Name").press("Enter"),
  ]);
  await expect(page.getByText(/already exists/i)).toBeVisible();
  await expect(page).toHaveURL(/\/patients\/new$/);

  // Editing the phone invalidates the warning and the confirm button; the new number is checked again.
  await page.getByLabel("Phone").fill("9123456780");
  await expect(page.getByText(/already exists/i)).toHaveCount(0);
  await expect(page.getByRole("button", { name: /register anyway/i })).toHaveCount(0);

  // Back to the duplicate number: warned again, and only the explicit click registers.
  await page.getByLabel("Phone").fill("9876543210");
  await page.getByRole("button", { name: /register patient/i }).click();
  await expect(page.getByText(/already exists/i)).toBeVisible();
  await page.getByRole("button", { name: /register anyway/i }).click();
  await expect(page.getByRole("heading", { name: "Meera Rao" })).toBeVisible();

  // Exactly two patients exist: the Enter press registered nothing.
  await page.goto("/patients");
  await expect(page.locator("tbody tr")).toHaveCount(2);
});

test("nurses can read patients but see no write controls", async ({ page }) => {
  const clinic = await newClinic(page, "nurse");
  await page.goto("/patients/new");
  await page.getByLabel("Name").fill("Ravi Kumar");
  await page.getByLabel("Phone").fill("9000011111");
  await page.getByLabel("Date of birth").fill("1980-01-15");
  await page.getByLabel("Address").fill("12 Lake Road");
  await page.getByLabel("Notes").fill("Prefers morning slots");
  await page.getByRole("button", { name: /register patient/i }).click();
  await expect(page.getByRole("heading", { name: "Ravi Kumar" })).toBeVisible();
  const detailUrl = page.url();

  await setRole(clinic.email, "nurse");

  await page.goto("/patients");
  await expect(page.getByRole("link", { name: "Ravi Kumar" })).toBeVisible();
  await expect(page.getByRole("link", { name: /new patient/i })).toHaveCount(0);

  await page.goto(detailUrl);
  await expect(page.getByRole("heading", { name: "Ravi Kumar" })).toBeVisible();
  await expect(page.getByRole("button", { name: /save changes/i })).toHaveCount(0);
  await expect(page.getByText("1980-01-15")).toBeVisible();
  await expect(page.getByText("12 Lake Road")).toBeVisible();
  await expect(page.getByText("Prefers morning slots")).toBeVisible();

  await page.goto("/patients/new");
  await expect(page).toHaveURL(/\/patients$/);
});

test("the list pages through more than 25 patients and tolerates bad params", async ({ page }) => {
  const clinic = await newClinic(page, "page");
  await seedPatients(clinic.email, 30);

  await page.goto("/patients");
  await expect(page.locator("tbody tr")).toHaveCount(25);
  await expect(page.getByText("Showing 1-25")).toBeVisible();
  await expect(page.getByRole("link", { name: "Previous" })).toHaveCount(0);
  await page.getByRole("link", { name: "Next" }).click();

  await expect(page).toHaveURL(/offset=25/);
  await expect(page.locator("tbody tr")).toHaveCount(5);
  await expect(page.getByText("Showing 26-30")).toBeVisible();
  await expect(page.getByRole("link", { name: "Seed Patient 001" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Next" })).toHaveCount(0);
  await page.getByRole("link", { name: "Previous" }).click();
  await expect(page.getByText("Showing 1-25")).toBeVisible();

  // Garbage offsets fall back to the first page; repeated params do not crash the page.
  await page.goto("/patients?offset=abc");
  await expect(page.getByText("Showing 1-25")).toBeVisible();
  await page.goto("/patients?offset=-5");
  await expect(page.getByText("Showing 1-25")).toBeVisible();
  const repeated = await page.goto("/patients?q=Seed&q=other&offset=1&offset=2");
  expect(repeated?.status()).toBe(200);
  await expect(page.getByRole("heading", { name: "Patients" })).toBeVisible();

  // Search keeps working with paging.
  await page.goto("/patients?q=Seed");
  await expect(page.getByText("Showing 1-25")).toBeVisible();
  await expect(page.getByRole("link", { name: "Next" })).toHaveAttribute("href", /q=Seed.*offset=25/);
});
