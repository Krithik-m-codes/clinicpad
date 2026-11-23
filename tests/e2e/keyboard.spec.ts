import { expect, test } from "@playwright/test";
import { cleanupClinic, registerClinic, type Clinic } from "./helpers";

const clinics: Clinic[] = [];

test.afterAll(async () => {
  for (const c of clinics) await cleanupClinic(c.email);
});

test("a receptionist can register a walk-in with the keyboard alone", async ({ page }) => {
  clinics.push(await registerClinic(page, "keys"));
  await page.goto("/patients/new");
  const started = Date.now();
  await expect(page.getByLabel("Name")).toBeFocused();
  await page.keyboard.type("Keyboard Walkin");
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Phone")).toBeFocused();
  await page.keyboard.type("98765 11111");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Keyboard Walkin" })).toBeVisible();
  const seconds = (Date.now() - started) / 1000;
  // Evidence that the flow allows a fast registration; the exit criterion itself is measured with real receptionists.
  console.log(`keyboard-only registration: ${seconds.toFixed(1)} s (automation)`);
  expect(seconds).toBeLessThan(30);
});

test("the skip link moves focus past the navigation", async ({ page }) => {
  clinics.push(await registerClinic(page, "skip"));
  await page.goto("/dashboard");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#main")).toBeFocused();
});

test("an unknown record shows the in-app not-found page, and a new clinic gets first-run links", async ({ page }) => {
  clinics.push(await registerClinic(page, "nf"));
  await expect(page.getByRole("link", { name: "Register your first patient" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Import from CSV" })).toBeVisible();
  await page.goto("/patients/00000000-0000-4000-8000-000000000000");
  await expect(page.getByRole("heading", { name: "Not found" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Go to the dashboard" })).toBeVisible();
});
