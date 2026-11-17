import { expect, test, type Page } from "@playwright/test";
import { cleanupClinic, ensureCatalogue, registerClinic, waitForEditor, type Clinic } from "./helpers";

const clinics: Clinic[] = [];

test.beforeAll(async () => {
  await ensureCatalogue();
});

test.afterAll(async () => {
  for (const c of clinics) await cleanupClinic(c.email);
});

async function newDraft(page: Page, patientName: string): Promise<string> {
  await page.goto("/patients/new");
  await page.getByLabel("Name").fill(patientName);
  await page.getByRole("button", { name: /register patient/i }).click();
  await expect(page.getByRole("heading", { name: patientName })).toBeVisible();
  await page.getByRole("button", { name: /new prescription/i }).click();
  await expect(page.getByRole("heading", { name: /draft prescription/i })).toBeVisible();
  await waitForEditor(page);
  return page.url();
}

const allSaved = (page: Page) => expect(page.getByText(/all changes saved/i)).toBeVisible({ timeout: 15_000 });

test("clinical form: vitals, catalogue, favourites, tests, and plain-text safety", async ({ page }) => {
  test.setTimeout(180_000);
  const dialogs: string[] = [];
  page.on("dialog", async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.dismiss();
  });
  clinics.push(await registerClinic(page, "clin"));
  await newDraft(page, "Meera Iyer");

  // Vitals, with BMI computed on the page.
  await page.getByLabel("BP systolic (mmHg)").fill("130");
  await page.getByLabel("BP diastolic (mmHg)").fill("85");
  await page.getByLabel("Pulse (/min)").fill("92");
  await page.getByLabel("Weight (kg)").fill("70");
  await page.getByLabel("Height (cm)").fill("175");
  await expect(page.getByLabel("BMI")).toHaveText("22.9");

  // A complaint from the global list.
  await page.getByLabel("Complaints", { exact: true }).fill("fever with ch");
  await page.getByRole("option", { name: "FEVER WITH CHILLS" }).click();
  await expect(page.getByRole("button", { name: "Remove FEVER WITH CHILLS" })).toBeVisible();

  // A medicine from the global catalogue fills its generic name.
  await page.getByLabel("Medicine name").first().fill("dolo 65");
  await page.getByRole("option", { name: /DOLO 650MG/ }).click();
  await expect(page.getByLabel("Medicine name").first()).toHaveValue("DOLO 650MG");
  await expect(page.getByLabel("Generic name").first()).toHaveValue("Paracetamol 650Mg");
  await page.getByRole("button", { name: "Schedule 1-0-1" }).first().click();
  await page.getByLabel("Food").first().selectOption("after");
  await page.getByLabel("Duration", { exact: true }).first().fill("5");

  // Saved as a favourite for next time.
  await page.getByRole("button", { name: /save as favourite/i }).first().click();
  await expect(page.getByText("Saved as favourite")).toBeVisible();

  // A free-text medicine that no list knows, added to the clinic list.
  await page.getByRole("button", { name: /add medicine/i }).click();
  await page.getByLabel("Medicine name").nth(1).fill("Clinic Special Syrup");
  await page.getByRole("option", { name: /to the clinic list/i }).click();
  await expect(page.getByText("Added to the clinic list")).toBeVisible();

  // An ordered test with instructions.
  const addTest = page.getByLabel("Add test", { exact: true });
  await addTest.fill("CBC");
  await addTest.press("Enter");
  await page.getByLabel("Test instructions").first().fill("Fasting not required");

  // Hostile-looking and Devanagari text is stored and shown as plain text.
  await page.getByLabel("Chief complaint").fill('<img src=x onerror="alert(1)"> fever');
  await page.getByLabel("Advice").fill("आराम करें। Drink fluids.");
  await allSaved(page);

  await page.reload();
  await expect(page.getByLabel("Pulse (/min)")).toHaveValue("92");
  await expect(page.getByLabel("Generic name").first()).toHaveValue("Paracetamol 650Mg");
  await expect(page.getByLabel("Morning dose").first()).toHaveValue("1");
  await expect(page.getByLabel("Night dose").first()).toHaveValue("1");
  await expect(page.getByLabel("Test name").first()).toHaveValue("CBC");
  await expect(page.getByLabel("Advice")).toHaveValue("आराम करें। Drink fluids.");

  await page.getByRole("button", { name: /^finalize$/i }).click();
  await expect(page.getByRole("heading", { name: /Rx #1/ })).toBeVisible();
  await expect(page.getByText('<img src=x onerror="alert(1)"> fever')).toBeVisible();
  await expect(page.getByRole("row", { name: /DOLO 650MG/ })).toContainText("1-0-1");
  await expect(page.getByText(/BP 130\/85 mmHg/)).toBeVisible();
  await expect(page.getByText(/CBC \(Fasting not required\)/)).toBeVisible();

  // The favourite pre-fills the next prescription.
  await newDraft(page, "Second Patient");
  await page.getByRole("button", { name: "Add favourite DOLO 650MG" }).click();
  await expect(page.getByLabel("Medicine name").first()).toHaveValue("DOLO 650MG");
  await expect(page.getByLabel("Duration", { exact: true }).first()).toHaveValue("5");
  await expect(page.getByLabel("Food").first()).toHaveValue("after");

  // The clinic medicine is now found by search.
  await page.getByRole("button", { name: /add medicine/i }).click();
  await page.getByLabel("Medicine name").nth(1).fill("clinic spec");
  await expect(page.getByRole("option", { name: /Clinic Special Syrup/ })).toBeVisible();

  expect(dialogs).toEqual([]);
});

test("autosave survives a dropped connection and refuses to overwrite another window", async ({ page, context }) => {
  test.setTimeout(180_000);
  clinics.push(await registerClinic(page, "auto"));
  const url = await newDraft(page, "Autosave Patient");

  await page.getByLabel("Advice").fill("First advice");
  await allSaved(page);

  // Offline: the edit stays on the page, is flagged as not saved, and saves once back online.
  await context.setOffline(true);
  await page.getByLabel("Advice").fill("Written while offline");
  await expect(page.getByText(/not saved yet/i)).toBeVisible({ timeout: 15_000 });
  await context.setOffline(false);
  await allSaved(page);
  await page.reload();
  await expect(page.getByLabel("Advice")).toHaveValue("Written while offline");

  // A second window on the same draft.
  const other = await context.newPage();
  await other.goto(url);
  await expect(other.getByLabel("Advice")).toHaveValue("Written while offline");

  await page.getByLabel("Advice").fill("Edited in window one");
  await allSaved(page);

  await other.getByLabel("Advice").fill("Edited in window two");
  await expect(other.getByText(/changed in another window/i)).toBeVisible({ timeout: 15_000 });
  await other.getByRole("button", { name: /reload latest version/i }).click();
  await expect(other.getByLabel("Advice")).toHaveValue("Edited in window one");

  // Window two's edit never reached the saved draft.
  await page.reload();
  await expect(page.getByLabel("Advice")).toHaveValue("Edited in window one");
  await other.close();
});

test("leaving the page: pending edits are sent on unmount, but a halted draft asks first", async ({ page }) => {
  test.setTimeout(180_000);
  const dialogs: string[] = [];
  page.on("dialog", async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.dismiss();
  });
  clinics.push(await registerClinic(page, "leave"));
  const url = await newDraft(page, "Leave Patient");

  // (a) A click on the patient link inside the debounce window: no prompt, and the edit is not lost.
  await page.getByLabel("Advice").fill("Typed just before leaving");
  await page.getByRole("link", { name: "Leave Patient" }).click();
  await expect(page.getByRole("heading", { name: "Leave Patient" })).toBeVisible();
  expect(dialogs).toEqual([]);
  await expect(async () => {
    await page.goto(url);
    await waitForEditor(page);
    await expect(page.getByLabel("Advice")).toHaveValue("Typed just before leaving", { timeout: 2_000 });
  }).toPass({ timeout: 20_000 });

  // (b) The server refuses the whole snapshot (Celsius typed into a Fahrenheit field): saving halts, and
  // everything since the last save is unsaved. Leaving must ask first.
  await page.getByLabel("Advice").fill("Written after the bad value");
  await page.getByLabel("Temperature (°F)").fill("37.8");
  await expect(page.getByText(/nothing since .* is saved/i)).toBeVisible({ timeout: 15_000 });
  dialogs.length = 0;
  await page.getByRole("link", { name: "Leave Patient" }).click();
  await expect.poll(() => dialogs.length).toBe(1);
  expect(dialogs[0]).toBe("You have changes that are not saved. Leave anyway?");
  expect(page.url()).toBe(url);
  await expect(page.getByLabel("Advice")).toHaveValue("Written after the bad value");

  page.removeAllListeners("dialog");
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("link", { name: "Leave Patient" }).click();
  await expect(page.getByRole("heading", { name: "Leave Patient" })).toBeVisible();
  expect(page.url()).not.toBe(url);
});
