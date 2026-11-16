import { expect, test } from "@playwright/test";
import { cleanupClinic, registerClinic, setRole, type Clinic } from "./helpers";

const clinics: Clinic[] = [];

test.afterAll(async () => {
  for (const c of clinics) await cleanupClinic(c.email);
});

test("write, save, finalize, amend, and repeat a prescription", async ({ page }) => {
  clinics.push(await registerClinic(page, "rx"));

  // A patient to prescribe for.
  await page.goto("/patients/new");
  await page.getByLabel("Name").fill("Ravi Sharma");
  await page.getByLabel("Phone").fill("9822012345");
  await page.getByLabel("Allergies").fill("Penicillin");
  await page.getByRole("button", { name: /register patient/i }).click();
  await expect(page.getByRole("heading", { name: "Ravi Sharma" })).toBeVisible();

  // Start a draft. The allergy is on the prescription screen, where the doctor chooses medicines.
  await page.getByRole("button", { name: /new prescription/i }).click();
  await expect(page).toHaveURL(/\/prescriptions\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { name: /draft prescription/i })).toBeVisible();
  await expect(page.getByText("Allergies: Penicillin")).toBeVisible();

  // Finalizing an empty draft is refused with a message.
  await page.getByRole("button", { name: /^finalize$/i }).click();
  await expect(page.getByText(/at least one medicine/i)).toBeVisible();

  // Fill and save.
  await page.getByLabel("Chief complaint").fill("Fever for 2 days");
  await page.getByLabel("Diagnosis").fill("Viral fever");
  await page.getByLabel("Medicine name").first().fill("Paracetamol");
  await page.getByLabel("Dose").first().fill("1 tablet");
  await page.getByLabel("Timing").first().fill("TDS");
  await page.getByLabel("Days").first().fill("3");
  await page.getByRole("button", { name: /add medicine/i }).click();
  await page.getByLabel("Medicine name").nth(1).fill("Cetirizine");
  await page.getByRole("button", { name: /save draft/i }).click();
  await expect(page.getByText(/^Saved at/)).toBeVisible();

  // The draft survives a reload.
  await page.reload();
  await expect(page.getByLabel("Chief complaint")).toHaveValue("Fever for 2 days");
  await expect(page.getByLabel("Medicine name").nth(1)).toHaveValue("Cetirizine");

  // Finalize -> read-only view with an Rx number.
  await page.getByRole("button", { name: /^finalize$/i }).click();
  await expect(page.getByRole("heading", { name: /Rx #1/ })).toBeVisible();
  await expect(page.getByText("Paracetamol")).toBeVisible();
  await expect(page.getByText("Allergies: Penicillin")).toBeVisible();
  await expect(page.getByRole("button", { name: /^finalize$/i })).toHaveCount(0);

  // Amend needs a reason.
  await page.getByRole("button", { name: /start amendment/i }).click();
  await expect(page.getByText(/at least 5 characters/i)).toBeVisible();
  await page.getByLabel("Reason for amendment").fill("Dose was wrong");
  await page.getByRole("button", { name: /start amendment/i }).click();
  await expect(page.getByRole("heading", { name: /draft amendment/i })).toBeVisible();
  await expect(page.getByText("Dose was wrong")).toBeVisible();

  await page.getByLabel("Dose").first().fill("2 tablets");
  await page.getByRole("button", { name: /^finalize$/i }).click();
  await expect(page.getByRole("heading", { name: /Rx #1 v2/ })).toBeVisible();
  await expect(page.getByText(/2 tablets/)).toBeVisible();

  // The patient page lists both versions with their statuses.
  await page.getByRole("link", { name: "Ravi Sharma" }).click();
  await expect(page.getByRole("link", { name: "Rx #1 v1" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Rx #1 v2" })).toBeVisible();
  await expect(page.getByRole("listitem").filter({ hasText: "Rx #1 v1" })).toContainText("amended");
  await expect(page.getByRole("listitem").filter({ hasText: "Rx #1 v2" })).toContainText("finalized");

  // A superseded version offers neither amend nor repeat.
  await page.getByRole("link", { name: "Rx #1 v1" }).click();
  await expect(page.getByRole("heading", { name: /Rx #1$/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /repeat as new prescription/i })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /start amendment/i })).toHaveCount(0);
  await page.goBack();

  // Repeat creates a new independent draft.
  await page.getByRole("link", { name: "Rx #1 v2" }).click();
  await page.getByRole("button", { name: /repeat as new prescription/i }).click();
  await expect(page.getByRole("heading", { name: /draft prescription/i })).toBeVisible();
  await expect(page.getByLabel("Medicine name").first()).toHaveValue("Paracetamol");
});

test("finalize keeps edits that were never saved, and hostile text stays inert", async ({ page }) => {
  clinics.push(await registerClinic(page, "rxunsaved"));

  await page.goto("/patients/new");
  await page.getByLabel("Name").fill("Unsaved Edits");
  await page.getByRole("button", { name: /register patient/i }).click();
  await expect(page.getByRole("heading", { name: "Unsaved Edits" })).toBeVisible();
  await page.getByRole("button", { name: /new prescription/i }).click();
  await expect(page.getByRole("heading", { name: /draft prescription/i })).toBeVisible();
  await expect(page.getByText("No known allergies recorded")).toBeVisible();

  // Finalize straight away, without pressing Save draft first.
  const hostile = "<img src=x onerror=alert(1)>";
  await page.getByLabel("Medicine name").first().fill(hostile);
  await page.getByLabel("Advice").fill("Rest <b>well</b>");
  await page.getByRole("button", { name: /^finalize$/i }).click();

  await expect(page.getByRole("heading", { name: /Rx #1/ })).toBeVisible();
  await expect(page.getByText(hostile)).toBeVisible();
  await expect(page.getByText("Rest <b>well</b>")).toBeVisible();
  await expect(page.locator("img[src='x']")).toHaveCount(0);
});

test("a malformed or unknown prescription id is a clean not-found", async ({ page }) => {
  clinics.push(await registerClinic(page, "rxnotfound"));

  for (const id of ["not-a-uuid", "00000000-0000-4000-8000-000000000000"]) {
    await page.goto(`/prescriptions/${id}`);
    await expect(page.getByText(/could not be found/i)).toBeVisible();
    await expect(page.getByLabel("Chief complaint")).toHaveCount(0);
  }
});

test("a reception user can read but not write prescriptions", async ({ page }) => {
  const clinic = await registerClinic(page, "rxperm");
  clinics.push(clinic);

  // The owner drafts a prescription and finalizes it, then is demoted to reception.
  await page.goto("/patients/new");
  await page.getByLabel("Name").fill("Reception Registered");
  await page.getByRole("button", { name: /register patient/i }).click();
  await expect(page.getByRole("heading", { name: "Reception Registered" })).toBeVisible();
  await page.getByRole("button", { name: /new prescription/i }).click();
  await page.getByLabel("Medicine name").first().fill("Ibuprofen");
  await page.getByRole("button", { name: /^finalize$/i }).click();
  await expect(page.getByRole("heading", { name: /Rx #1/ })).toBeVisible();
  const rxUrl = page.url();

  // Roles are re-read per request, so a direct role change takes effect immediately.
  await setRole(clinic.email, "reception");

  await page.goto(rxUrl);
  await expect(page.getByRole("heading", { name: /Rx #1/ })).toBeVisible();
  await expect(page.getByText("Ibuprofen")).toBeVisible();
  await expect(page.getByRole("button", { name: /start amendment/i })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /repeat as new prescription/i })).toHaveCount(0);

  await page.getByRole("link", { name: "Reception Registered" }).click();
  await expect(page.getByRole("heading", { name: "Reception Registered" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Rx #1 v1" })).toBeVisible();
  await expect(page.getByRole("button", { name: /new prescription/i })).toHaveCount(0);
});

test("an accountant cannot open a prescription", async ({ page }) => {
  const clinic = await registerClinic(page, "rxacct");
  clinics.push(clinic);

  await page.goto("/patients/new");
  await page.getByLabel("Name").fill("Hidden Patient");
  await page.getByRole("button", { name: /register patient/i }).click();
  await page.getByRole("button", { name: /new prescription/i }).click();
  await expect(page.getByRole("heading", { name: /draft prescription/i })).toBeVisible();
  const rxUrl = page.url();

  await setRole(clinic.email, "accountant");

  await page.goto(rxUrl);
  await expect(page.getByText(/could not be found/i)).toBeVisible();
  await expect(page.getByLabel("Chief complaint")).toHaveCount(0);
});
