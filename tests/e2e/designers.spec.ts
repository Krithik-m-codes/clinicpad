import { expect, test } from "@playwright/test";
import { cleanupClinic, registerClinic, setRole, withAdminSql, type Clinic } from "./helpers";

const clinics: Clinic[] = [];
const designerEmails: string[] = [];

test.afterAll(async () => {
  for (const c of clinics) await cleanupClinic(c.email);
  for (const e of designerEmails) await withAdminSql((sql) => sql`delete from users where email = ${e}`);
});

test("the owner invites a designer, who reaches templates only; extend, revoke and the sign-in refusal", async ({ page, browser }) => {
  test.setTimeout(240_000);
  const clinic = await registerClinic(page, "designer-e2e");
  clinics.push(clinic);
  const designerEmail = `setup-${Date.now()}@example.com`;
  designerEmails.push(designerEmail);

  // Settings links to the page; the page is owner-only.
  await page.goto("/settings");
  await page.getByRole("link", { name: "Invite a pad designer" }).click();
  await expect(page).toHaveURL(/\/settings\/designers$/);

  // Mandatory expiry: the form refuses 0 and 31 on the server (the browser also constrains the input).
  await page.getByLabel("Email").fill(designerEmail);
  await page.getByLabel("Access lasts (days)").fill("7");
  await page.getByRole("button", { name: "Create setup account" }).click();
  const note = page.getByTestId("handover-note");
  await expect(note).toBeVisible({ timeout: 30_000 });
  const noteText = (await note.locator("pre").textContent()) ?? "";
  expect(noteText).toContain(designerEmail);
  expect(noteText).toMatch(/templates only/i);
  const password = /Temporary password: (\S+)/.exec(noteText)?.[1] ?? "";
  expect(password.length).toBeGreaterThanOrEqual(20);

  const row = page.getByTestId("designer-row").filter({ hasText: designerEmail });
  await expect(row.getByTestId("designer-status")).toHaveText("Active");

  // A second, anonymous browser context signs in as the designer.
  const designerContext = await browser.newContext({ baseURL: page.url().split("/settings")[0] });
  const designer = await designerContext.newPage();
  await designer.goto("/login");
  await designer.getByLabel("Email").fill(designerEmail);
  await designer.getByLabel("Password").fill(password);
  await designer.getByRole("button", { name: /sign in/i }).click();
  await expect(designer).toHaveURL(/\/templates$/, { timeout: 60_000 });
  await expect(designer.getByRole("link", { name: "Settings", exact: true })).toHaveCount(0);

  // Not the owner's page, not patients.
  for (const url of ["/settings/designers", "/settings", "/patients"]) {
    await designer.goto(url).catch((error: Error) => {
      if (!/ERR_ABORTED/.test(error.message)) throw error;
    });
    await expect(designer).not.toHaveURL(new RegExp(`${url.replace("/", "\\/")}$`), { timeout: 30_000 });
  }

  // The owner extends, then revokes; the designer's next request is refused.
  await row.getByLabel("Extend by (days from today)").fill("14");
  await row.getByRole("button", { name: "Extend" }).click();
  await expect(row.getByTestId("designer-status")).toHaveText("Active");
  await row.getByRole("button", { name: "Revoke now" }).click();
  await expect(row.getByTestId("designer-status")).toHaveText("Revoked", { timeout: 30_000 });
  await expect(row.getByRole("button", { name: "Extend" })).toHaveCount(0);

  await designer.goto("/templates").catch((error: Error) => {
    if (!/ERR_ABORTED/.test(error.message)) throw error;
  });
  await expect(designer).toHaveURL(/\/login/, { timeout: 30_000 });
  await designer.goto("/login");
  await designer.getByLabel("Email").fill(designerEmail);
  await designer.getByLabel("Password").fill(password);
  await designer.getByRole("button", { name: /sign in/i }).click();
  await expect(designer).toHaveURL(/\/login/);
  await designerContext.close();

  // Only the owner sees the page.
  await setRole(clinic.email, "doctor");
  await page.goto("/settings/designers").catch((error: Error) => {
    if (!/ERR_ABORTED/.test(error.message)) throw error;
  });
  await expect(page).not.toHaveURL(/\/settings\/designers$/, { timeout: 30_000 });
});
