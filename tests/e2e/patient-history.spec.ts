import { expect, test, type Page } from "@playwright/test";
import { cleanupClinic, ensureCatalogue, registerClinic, waitForEditor, type Clinic } from "./helpers";

const clinics: Clinic[] = [];

test.beforeAll(async () => {
  await ensureCatalogue();
});

test.afterAll(async () => {
  for (const c of clinics) await cleanupClinic(c.email);
});

async function newDraft(page: Page, patientUrl: string): Promise<void> {
  await page.goto(patientUrl);
  await page.getByRole("button", { name: "New prescription", exact: true }).click();
  await expect(page.getByRole("heading", { name: /draft prescription/i })).toBeVisible();
  await waitForEditor(page);
}

test("filter a patient's prescriptions, repeat from the list, archive and restore", async ({ page }) => {
  test.setTimeout(180_000);
  clinics.push(await registerClinic(page, "history"));
  await page.goto("/patients/new");
  await page.getByLabel("Name").fill("Meena History");
  await page.getByRole("button", { name: /register patient/i }).click();
  await expect(page.getByRole("heading", { name: "Meena History" })).toBeVisible();
  const patientUrl = page.url();

  // One finalized prescription and one draft.
  await newDraft(page, patientUrl);
  await page.getByLabel("Medicine name").first().fill("Paracetamol");
  await page.getByRole("button", { name: /^finalize$/i }).click();
  await expect(page.getByRole("heading", { name: /Rx #1/ })).toBeVisible({ timeout: 15_000 });
  await newDraft(page, patientUrl);

  await page.goto(patientUrl);
  const history = page.getByRole("region", { name: "Prescriptions" });
  await expect(history.getByRole("listitem")).toHaveCount(2);
  await history.getByLabel("Status").selectOption("finalized");
  await history.getByRole("button", { name: "Apply" }).click();
  await expect(page).toHaveURL(/status=finalized/);
  await expect(history.getByRole("listitem")).toHaveCount(1);
  await expect(history.getByRole("link", { name: "Rx #1 v1" })).toBeVisible();
  await expect(history.getByRole("button", { name: "Print" })).toBeVisible();

  // Repeat from the list opens a new draft.
  await history.getByRole("button", { name: /repeat as new prescription/i }).click();
  await expect(page.getByRole("heading", { name: /draft prescription/i })).toBeVisible();

  // Archive: gone from the list, back through Show archived.
  await page.goto(patientUrl);
  await page.getByRole("button", { name: "Archive patient" }).click();
  await page.getByRole("button", { name: "Yes, archive patient" }).click();
  await expect(page).toHaveURL(/\/patients\?notice=archived/);
  await expect(page.getByText("Patient archived.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Meena History" })).toHaveCount(0);
  await page.getByRole("link", { name: "Show archived" }).click();
  await page.getByRole("link", { name: "Meena History" }).click();
  await expect(page.getByText(/^Archived on/)).toBeVisible();
  await expect(page.getByRole("button", { name: "New prescription", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Restore patient" }).click();
  await expect(page.getByRole("button", { name: "New prescription", exact: true })).toBeVisible();
});
