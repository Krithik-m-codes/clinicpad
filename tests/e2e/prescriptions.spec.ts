import { expect, test } from "@playwright/test";
import { cleanupClinic, registerClinic, setRole, waitForEditor, type Clinic } from "./helpers";

const clinics: Clinic[] = [];

test.afterAll(async () => {
  for (const c of clinics) await cleanupClinic(c.email);
});

test("write, autosave, finalize, amend, and repeat a prescription", async ({ page }) => {
  test.setTimeout(180_000);
  clinics.push(await registerClinic(page, "rx"));

  // A patient to prescribe for.
  await page.goto("/patients/new");
  await page.getByLabel("Name").fill("Ravi Sharma");
  await page.getByLabel("Phone").fill("9822012345");
  await page.getByLabel("Allergies").fill("Penicillin");
  await page.getByRole("button", { name: /register patient/i }).click();
  await expect(page.getByRole("heading", { name: "Ravi Sharma" })).toBeVisible();

  // Start a draft. The allergy is on the prescription screen, where the doctor chooses medicines.
  await page.getByRole("button", { name: "New prescription", exact: true }).click();
  await expect(page).toHaveURL(/\/prescriptions\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { name: /draft prescription/i })).toBeVisible();
  await expect(page.getByText("Allergies: Penicillin")).toBeVisible();
  await waitForEditor(page);

  // Finalizing an empty draft is refused with a message.
  await page.getByRole("button", { name: /^finalize$/i }).click();
  await expect(page.getByText(/at least one medicine/i)).toBeVisible();

  // Fill the form; autosave does the rest.
  await page.getByLabel("Chief complaint").fill("Fever for 2 days");
  const diagnosis = page.getByLabel("Diagnosis", { exact: true });
  await diagnosis.fill("Viral fever");
  await diagnosis.press("Enter");
  await page.getByLabel("Medicine name").first().fill("Paracetamol");
  await page.getByLabel("Dose", { exact: true }).first().fill("1 tablet");
  await page.getByRole("button", { name: "Schedule 1-1-1" }).first().click();
  await page.getByLabel("Duration", { exact: true }).first().fill("3");
  await page.getByRole("button", { name: /add medicine/i }).click();
  await page.getByLabel("Medicine name").nth(1).fill("Cetirizine");
  await expect(page.getByText(/all changes saved/i)).toBeVisible({ timeout: 15_000 });

  // The draft survives a reload.
  await page.reload();
  await waitForEditor(page);
  await expect(page.getByLabel("Chief complaint")).toHaveValue("Fever for 2 days");
  await expect(page.getByRole("button", { name: "Remove Viral fever" })).toBeVisible();
  await expect(page.getByLabel("Medicine name").nth(1)).toHaveValue("Cetirizine");
  await expect(page.getByLabel("Morning dose").first()).toHaveValue("1");

  // Finalize -> read-only view with an Rx number; the allergy stays visible.
  await page.getByRole("button", { name: /^finalize$/i }).click();
  await expect(page.getByRole("heading", { name: /Rx #1/ })).toBeVisible();
  await expect(page.getByRole("cell", { name: /Paracetamol/ })).toBeVisible();
  await expect(page.getByRole("cell", { name: /1-1-1/ })).toBeVisible();
  await expect(page.getByText("Allergies: Penicillin")).toBeVisible();
  await expect(page.getByRole("button", { name: /^finalize$/i })).toHaveCount(0);

  // Amend needs a reason and copies the clinical content.
  await page.getByRole("button", { name: /start amendment/i }).click();
  await expect(page.getByText(/at least 5 characters/i)).toBeVisible();
  await page.getByLabel("Reason for amendment").fill("Dose was wrong");
  await page.getByRole("button", { name: /start amendment/i }).click();
  await expect(page.getByRole("heading", { name: /draft amendment/i })).toBeVisible();
  await expect(page.getByText("Dose was wrong")).toBeVisible();
  await waitForEditor(page);
  await expect(page.getByLabel("Morning dose").first()).toHaveValue("1");

  // Finalize straight after an edit: the pending edit is included.
  await page.getByLabel("Dose", { exact: true }).first().fill("2 tablets");
  await page.getByRole("button", { name: /^finalize$/i }).click();
  await expect(page.getByRole("heading", { name: /Rx #1 v2/ })).toBeVisible();
  await expect(page.getByText(/2 tablets/)).toBeVisible();

  // The patient page lists both versions with their statuses.
  await page.getByRole("link", { name: "Ravi Sharma" }).click();
  await expect(page.getByRole("link", { name: "Rx #1 v1" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Rx #1 v2" })).toBeVisible();
  await expect(page.getByRole("listitem").filter({ hasText: "Rx #1 v1" })).toContainText("Superseded");
  await expect(page.getByRole("listitem").filter({ hasText: "Rx #1 v2" })).toContainText("Finalized");

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
  await waitForEditor(page);
  await expect(page.getByLabel("Medicine name").first()).toHaveValue("Paracetamol");
});

test("finalize keeps edits autosave has not sent yet, and hostile text stays inert", async ({ page }) => {
  clinics.push(await registerClinic(page, "rxunsaved"));

  await page.goto("/patients/new");
  await page.getByLabel("Name").fill("Unsaved Edits");
  await page.getByRole("button", { name: /register patient/i }).click();
  await expect(page.getByRole("heading", { name: "Unsaved Edits" })).toBeVisible();
  await page.getByRole("button", { name: "New prescription", exact: true }).click();
  await expect(page.getByRole("heading", { name: /draft prescription/i })).toBeVisible();
  await expect(page.getByText("No known allergies recorded")).toBeVisible();
  await waitForEditor(page);

  // Finalize straight away, before the autosave debounce fires.
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
  test.setTimeout(120_000);
  const clinic = await registerClinic(page, "rxperm");
  clinics.push(clinic);

  // The owner finalizes one prescription and leaves a second one as a draft, then is demoted to reception.
  await page.goto("/patients/new");
  await page.getByLabel("Name").fill("Reception Registered");
  await page.getByRole("button", { name: /register patient/i }).click();
  await expect(page.getByRole("heading", { name: "Reception Registered" })).toBeVisible();
  const patientUrl = page.url();
  await page.getByRole("button", { name: "New prescription", exact: true }).click();
  await waitForEditor(page);
  await page.getByLabel("Medicine name").first().fill("Ibuprofen");
  await page.getByRole("button", { name: /^finalize$/i }).click();
  await expect(page.getByRole("heading", { name: /Rx #1/ })).toBeVisible();
  const rxUrl = page.url();

  await page.goto(patientUrl);
  await page.getByRole("button", { name: "New prescription", exact: true }).click();
  await expect(page.getByRole("heading", { name: /draft prescription/i })).toBeVisible();
  const draftUrl = page.url();

  // Roles are re-read per request, so a direct role change takes effect immediately.
  await setRole(clinic.email, "reception");

  await page.goto(rxUrl);
  await expect(page.getByRole("heading", { name: /Rx #1/ })).toBeVisible();
  await expect(page.getByText("Ibuprofen")).toBeVisible();
  await expect(page.getByRole("button", { name: /start amendment/i })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /repeat as new prescription/i })).toHaveCount(0);

  // A draft is readable, but has no editor and no Finalize.
  await page.goto(draftUrl);
  await expect(page.getByRole("heading", { name: /draft prescription/i })).toBeVisible();
  await expect(page.getByLabel("Medicine name")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^finalize$/i })).toHaveCount(0);

  await page.getByRole("link", { name: "Reception Registered" }).click();
  await expect(page.getByRole("heading", { name: "Reception Registered" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Rx #1 v1" })).toBeVisible();
  await expect(page.getByRole("button", { name: "New prescription", exact: true })).toHaveCount(0);
});

test("an accountant cannot open a prescription", async ({ page }) => {
  const clinic = await registerClinic(page, "rxacct");
  clinics.push(clinic);

  await page.goto("/patients/new");
  await page.getByLabel("Name").fill("Hidden Patient");
  await page.getByRole("button", { name: /register patient/i }).click();
  await page.getByRole("button", { name: "New prescription", exact: true }).click();
  await expect(page.getByRole("heading", { name: /draft prescription/i })).toBeVisible();
  const rxUrl = page.url();

  await setRole(clinic.email, "accountant");

  await page.goto(rxUrl);
  await expect(page.getByText(/could not be found/i)).toBeVisible();
  await expect(page.getByLabel("Chief complaint")).toHaveCount(0);
});

test("discard a draft and withdraw an amendment", async ({ page }) => {
  test.setTimeout(120_000);
  clinics.push(await registerClinic(page, "rxdiscard"));

  await page.goto("/patients/new");
  await page.getByLabel("Name").fill("Discard Case");
  await page.getByRole("button", { name: /register patient/i }).click();
  await expect(page.getByRole("heading", { name: "Discard Case" })).toBeVisible();

  // An unwanted draft: Discard asks first; "Keep it" changes nothing; confirming returns to the patient.
  await page.getByRole("button", { name: "New prescription", exact: true }).click();
  await waitForEditor(page);
  await page.getByLabel("Medicine name").first().fill("Unwanted");
  await page.getByRole("button", { name: "Discard draft" }).click();
  await page.getByRole("button", { name: "Keep it" }).click();
  await expect(page.getByLabel("Medicine name").first()).toHaveValue("Unwanted");
  await page.getByRole("button", { name: "Discard draft" }).click();
  await page.getByRole("button", { name: /yes, discard draft/i }).click();
  await expect(page.getByRole("heading", { name: "Discard Case" })).toBeVisible();
  await expect(page.getByText("No prescriptions yet.")).toBeVisible();

  // A finalized prescription and a correction that is withdrawn: the original stays and can be amended again.
  await page.getByRole("button", { name: "New prescription", exact: true }).click();
  await waitForEditor(page);
  await page.getByLabel("Medicine name").first().fill("Kept Medicine");
  await page.getByRole("button", { name: /^finalize$/i }).click();
  await expect(page.getByRole("heading", { name: /Rx #1/ })).toBeVisible();
  const rxUrl = page.url();
  await expect(page.getByRole("button", { name: "Discard draft" })).toHaveCount(0);

  await page.getByLabel("Reason for amendment").fill("Wrong patient selected");
  await page.getByRole("button", { name: /start amendment/i }).click();
  await expect(page.getByRole("heading", { name: /draft amendment/i })).toBeVisible();
  await waitForEditor(page);
  await page.getByRole("button", { name: "Withdraw amendment" }).click();
  await page.getByRole("button", { name: /yes, withdraw amendment/i }).click();
  await expect(page).toHaveURL(rxUrl);
  await expect(page.getByRole("heading", { name: /Rx #1$/ })).toBeVisible();
  await expect(page.getByRole("cell", { name: /Kept Medicine/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /start amendment/i })).toBeVisible();
});
