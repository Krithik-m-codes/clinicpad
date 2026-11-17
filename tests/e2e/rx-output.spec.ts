import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { cleanupClinic, ensureCatalogue, registerClinic, setRole, waitForEditor, type Clinic } from "./helpers";

const clinics: Clinic[] = [];
const gotenbergUrl = process.env.GOTENBERG_URL ?? "http://localhost:3001";

async function gotenbergUp(): Promise<boolean> {
  try {
    return (await fetch(`${gotenbergUrl}/health`, { signal: AbortSignal.timeout(2000) })).ok;
  } catch {
    return false;
  }
}

test.beforeAll(async () => {
  await ensureCatalogue();
});

test.afterAll(async () => {
  for (const c of clinics) await cleanupClinic(c.email);
});

async function completeProfile(page: Page): Promise<void> {
  await page.goto("/settings/profile");
  await page.getByLabel("Qualifications").fill("MBBS, MD (Medicine)");
  await page.getByLabel("Registration number").fill("MMC/2026/0042");
  await page.getByRole("button", { name: "Save profile" }).click();
  await expect(page.getByText("Saved.", { exact: true })).toBeVisible();
}

async function registerPatient(page: Page, name: string): Promise<string> {
  await page.goto("/patients/new");
  await page.getByLabel("Name").fill(name);
  await page.getByRole("button", { name: /register patient/i }).click();
  await expect(page.getByRole("heading", { name })).toBeVisible();
  return page.url();
}

async function startDraft(page: Page, patientUrl: string): Promise<string> {
  await page.goto(patientUrl);
  await page.getByRole("button", { name: /new prescription/i }).click();
  await expect(page.getByRole("heading", { name: /draft prescription/i })).toBeVisible();
  await waitForEditor(page);
  return page.url();
}

/** Types one medicine into the hydrated editor and finalizes; the page refreshes into the finalized view. */
async function finalizeDraft(page: Page, drug: string, heading: RegExp): Promise<string> {
  await waitForEditor(page);
  await page.getByLabel("Medicine name").first().fill(drug);
  await page.getByRole("button", { name: /^finalize$/i }).click();
  await expect(page.getByRole("heading", { name: heading })).toBeVisible({ timeout: 15_000 });
  return page.url();
}

test("print and download a finalized prescription; a reprint keeps the finalized details", async ({ page }) => {
  test.setTimeout(180_000);
  clinics.push(await registerClinic(page, "rxout"));
  await completeProfile(page);
  const patientUrl = await registerPatient(page, "Asha <b>Rao</b>");
  await startDraft(page, patientUrl);
  const rxUrl = await finalizeDraft(page, "Paracetamol", /Rx #1/);
  await expect(page.getByText("Not printed or downloaded yet.")).toBeVisible();

  // Print: the hidden frame loads the pad and the browser's print() is called.
  const [printed] = await Promise.all([
    page.waitForResponse((r) => r.url().includes("/document?purpose=print")),
    page.getByRole("button", { name: "Print", exact: true }).click(),
  ]);
  expect(printed.status()).toBe(200);
  const frame = page.frameLocator('iframe[title="Prescription print frame"]');
  await expect(frame.locator("body")).toContainText("MMC/2026/0042");
  await expect(frame.locator("body")).toContainText("Asha <b>Rao</b>");
  await expect(frame.locator("script")).toHaveCount(0);

  const up = await gotenbergUp();
  if (up) {
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download PDF" }).click()]);
    expect(download.suggestedFilename()).toBe("Rx-1-v1.pdf");
    const file = await download.path();
    expect((await readFile(file)).subarray(0, 5).toString("latin1")).toBe("%PDF-");
  } else {
    await page.getByRole("button", { name: "Download PDF" }).click();
    // getByText, not getByRole("alert"): Next's route announcer is an alert region too.
    await expect(page.getByText(/PDF service is not available right now/)).toBeVisible();
  }

  await page.reload();
  await expect(page.getByText(up ? /Printed or downloaded 2 times/ : /Printed or downloaded 1 time,/)).toBeVisible();

  // Rename the patient; the finalized pad and the page header keep the name it was finalized with.
  await page.goto(patientUrl);
  await page.getByLabel("Name").fill("Renamed Rao");
  await page.getByRole("button", { name: /save changes/i }).click();
  await expect(page.getByRole("heading", { name: "Renamed Rao" })).toBeVisible();
  const reprint = await page.request.get(`${rxUrl}/document?purpose=preview`);
  const markup = await reprint.text();
  expect(markup).toContain("Asha &lt;b&gt;Rao&lt;/b&gt;");
  expect(markup).not.toContain("Renamed Rao");
  await page.goto(rxUrl);
  await expect(page.getByRole("link", { name: "Asha <b>Rao</b>" })).toBeVisible();
  await expect(page.getByText(/now recorded as Renamed Rao/)).toBeVisible();
});

test("a draft previews with a watermark, cannot be printed, warns about a missing registration number, and is marked for read-only roles", async ({ page }) => {
  test.setTimeout(120_000);
  const clinic = await registerClinic(page, "rxdraft");
  clinics.push(clinic);
  const draftUrl = await startDraft(page, await registerPatient(page, "Draft Person"));

  await expect(page.getByText(/missing your registration number/i)).toBeVisible();
  await expect(page.getByRole("link", { name: "Complete your profile" })).toHaveAttribute("href", "/settings/profile");
  await expect(page.getByRole("button", { name: "Print", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Download PDF" })).toHaveCount(0);

  const href = await page.getByRole("link", { name: "Preview pad" }).getAttribute("href");
  expect(href).toMatch(/\/document\?purpose=preview$/);
  const preview = await page.request.get(href ?? "");
  expect(preview.status()).toBe(200);
  expect(await preview.text()).toContain("DRAFT · NOT VALID FOR DISPENSING");

  expect((await page.request.get(`${draftUrl}/document?purpose=print`)).status()).toBe(409);
  const pdf = await page.request.get(`${draftUrl}/pdf`);
  expect(pdf.status()).toBe(409);
  expect(await pdf.json()).toMatchObject({ error: "conflict" });

  // Roles are re-read on every request: a reception user sees the draft marked as not a prescription.
  await setRole(clinic.email, "reception");
  await page.goto(draftUrl);
  await expect(page.getByText(/This draft is not a prescription yet/)).toBeVisible();
  await expect(page.getByLabel("Medicine name")).toHaveCount(0);

  // An accountant gets the same not-found as an unknown id, on the page and on the document.
  await setRole(clinic.email, "accountant");
  expect((await page.request.get(`${draftUrl}/document?purpose=preview`)).status()).toBe(404);
  await page.goto(draftUrl);
  await expect(page.getByRole("heading", { name: /draft prescription/i })).toHaveCount(0);
  await expect(page.getByText(/could not be found/i)).toBeVisible();
  await expect(page.getByRole("button", { name: "Preview pad" })).toHaveCount(0);
});

test("a superseded version is marked, stays printable, and offers no repeat or amendment", async ({ page }) => {
  test.setTimeout(180_000);
  clinics.push(await registerClinic(page, "rxsup"));
  await completeProfile(page);
  await startDraft(page, await registerPatient(page, "Version Person"));
  const v1Url = await finalizeDraft(page, "Amoxicillin", /Rx #1/);

  await page.getByLabel("Reason for amendment").fill("Dose was wrong");
  await page.getByRole("button", { name: /start amendment/i }).click();
  await expect(page.getByRole("heading", { name: /draft amendment/i })).toBeVisible();
  await waitForEditor(page);
  await page.getByRole("button", { name: /^finalize$/i }).click();
  await expect(page.getByRole("heading", { name: /Rx #1 v2/ })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("link", { name: "version 1" })).toBeVisible();
  await expect(page.getByRole("button", { name: /repeat as new prescription/i })).toBeVisible();

  await page.goto(v1Url);
  await expect(page.getByText(/Superseded by/)).toBeVisible();
  await expect(page.getByRole("link", { name: "version 2" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Print", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Download PDF" })).toBeVisible();
  await expect(page.getByRole("button", { name: /repeat as new prescription/i })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /start amendment/i })).toHaveCount(0);

  const old = await page.request.get(`${v1Url}/document?purpose=preview`);
  expect(await old.text()).toContain("SUPERSEDED by version 2");
});

test("signed-out document links go to the login page", async ({ browser, baseURL }) => {
  const context = await browser.newContext();
  const fresh = await context.newPage();
  await fresh.goto(`${baseURL}/prescriptions/0190a1b2-3c4d-7e5f-8a9b-0c1d2e3f4a5b/document?purpose=print`);
  await expect(fresh).toHaveURL(/\/login/);
  await context.close();
});
