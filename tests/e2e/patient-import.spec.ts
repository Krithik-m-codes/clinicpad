import { expect, test, type Page } from "@playwright/test";
import { cleanupClinic, registerClinic, setRole, type Clinic } from "./helpers";

const clinics: Clinic[] = [];

test.afterAll(async () => {
  for (const c of clinics) await cleanupClinic(c.email);
});

// Excel's "CSV UTF-8" export: a BOM, CRLF, an Age column, a Devanagari name, a date that does not exist.
const FILE = [
  "\uFEFFPatient Name,Mobile,DOB,Sex,Age",
  "Asha Import,98765 00001,15/08/1990,F,35",
  "\u0938\u0941\u0928\u0940\u0924\u093E \u0907\u092E\u094D\u092A\u094B\u0930\u094D\u091F,98765 00002,,F,",
  "Bad Date,98765 00003,31/02/1990,M,",
  "",
].join("\r\n");

async function upload(page: Page): Promise<void> {
  await page.goto("/patients/import");
  const check = page.getByRole("button", { name: "Check file" });
  // Choosing the file before the page has hydrated is lost; choose again until the button enables.
  await expect(async () => {
    await page.getByLabel("CSV file").setInputFiles({ name: "patients.csv", mimeType: "text/csv", buffer: Buffer.from(FILE, "utf8") });
    await expect(check).toBeEnabled({ timeout: 1_000 });
  }).toPass({ timeout: 20_000 });
  await check.click();
}

test("import a spreadsheet export with a validation report; a re-run imports nothing", async ({ page }) => {
  test.setTimeout(120_000);
  clinics.push(await registerClinic(page, "import"));
  await page.goto("/patients");
  await page.getByRole("link", { name: "Import from CSV" }).click();
  await expect(page.getByRole("heading", { name: "Import from CSV" })).toBeVisible();

  await upload(page);
  await expect(page.getByText("2 ready to import")).toBeVisible();
  await expect(page.getByText("1 with problems")).toBeVisible();
  await expect(page.getByText("This date does not exist.")).toBeVisible();
  await expect(page.getByText(/Not imported: Age/)).toBeVisible();
  await expect(page.getByRole("cell", { name: "1990-08-15" })).toBeVisible();

  await page.getByRole("button", { name: "Import 2 patients" }).click();
  await expect(page.getByText(/Imported 2 patients \(#1 to #2\)/)).toBeVisible();

  await page.goto("/patients");
  await expect(page.getByRole("link", { name: "Asha Import" })).toBeVisible();
  await expect(page.getByRole("link", { name: "\u0938\u0941\u0928\u0940\u0924\u093E \u0907\u092E\u094D\u092A\u094B\u0930\u094D\u091F" })).toBeVisible();

  await upload(page);
  await expect(page.getByText("2 already imported")).toBeVisible();
  await expect(page.getByRole("button", { name: "Nothing to import" })).toBeDisabled();
});

test("non-owners cannot open the import page", async ({ page }) => {
  const clinic = await registerClinic(page, "import-role");
  clinics.push(clinic);
  await setRole(clinic.email, "reception");
  await page.goto("/patients/import");
  await expect(page).toHaveURL(/\/patients$/);
  await expect(page.getByRole("link", { name: "Import from CSV" })).toHaveCount(0);
});
