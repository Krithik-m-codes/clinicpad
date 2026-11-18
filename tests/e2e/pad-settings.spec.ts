import { expect, test } from "@playwright/test";
import { makePng } from "../helpers/images";
import { cleanupClinic, registerClinic, setRole, type Clinic } from "./helpers";

let clinic: Clinic;

test.afterAll(async () => {
  if (clinic) await cleanupClinic(clinic.email);
});

test("an owner sets up the prescription pad, logo, profile, and signature", async ({ page }) => {
  test.setTimeout(120_000);
  clinic = await registerClinic(page, "pad");
  let dialogs = 0;
  page.on("dialog", async (dialog) => {
    dialogs += 1;
    await dialog.dismiss();
  });

  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: /clinic settings/i })).toBeVisible();
  await page.getByLabel("Address line 1").fill("12 MG Road");
  await page.getByLabel("City").fill("Pune");
  await page.getByLabel("PIN code").fill("411001");
  await page.getByLabel("Phone on pad").fill("020-2612 3456");
  await page.getByLabel("Footer lines").fill("Closed on Sundays\nPlease bring your previous prescriptions");
  await page.getByLabel("Template").selectOption("paediatric");
  await page.getByLabel("Paper size").selectOption("A5");
  await page.getByLabel("Label language").selectOption("bilingual");
  await page.getByRole("button", { name: "Save pad" }).click();
  await expect(page.getByText("Saved.", { exact: true })).toBeVisible();

  await page.reload();
  await expect(page.getByLabel("Address line 1")).toHaveValue("12 MG Road");
  await expect(page.getByLabel("Template")).toHaveValue("paediatric");
  await expect(page.getByLabel("Paper size")).toHaveValue("A5");

  // A file that claims to be a PNG but is an SVG with a script is refused by the server.
  await page.getByLabel("Clinic logo").setInputFiles({ name: "evil.png", mimeType: "image/png", buffer: Buffer.from("<svg onload=alert(1)>") });
  await page.getByRole("button", { name: "Upload" }).click();
  // getByText, not getByRole("alert"): Next.js's route announcer is also an alert region.
  await expect(page.getByText("Upload a PNG or JPEG image.")).toBeVisible();

  // Over 512 KB: refused in the browser with a friendly message, never sent.
  await page.getByLabel("Clinic logo").setInputFiles({ name: "huge.png", mimeType: "image/png", buffer: Buffer.alloc(600 * 1024) });
  await expect(page.getByText("The image is larger than 512 KB.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Upload" })).toBeDisabled();

  // An SVG declared as such is refused in the browser too.
  await page.getByLabel("Clinic logo").setInputFiles({ name: "x.svg", mimeType: "image/svg+xml", buffer: Buffer.from("<svg onload=alert(1)></svg>") });
  await expect(page.getByText("Choose a PNG or JPEG image.")).toBeVisible();

  await page.getByLabel("Clinic logo").setInputFiles({ name: "logo.png", mimeType: "image/png", buffer: makePng(120, 60) });
  await page.getByRole("button", { name: "Upload" }).click();
  await expect(page.getByText("Image saved.")).toBeVisible();
  await expect(page.getByRole("img", { name: "Current clinic logo" })).toBeVisible();

  await page.getByRole("button", { name: "Remove" }).click();
  await expect(page.getByText("No image yet.")).toBeVisible();

  await page.getByRole("link", { name: /edit your doctor profile/i }).click();
  await expect(page.getByRole("heading", { name: /doctor profile/i })).toBeVisible();
  await expect(page.getByLabel("Name on prescriptions")).toHaveValue("Dr. E2E Tester");
  await page.getByLabel("Qualifications").fill("MBBS, MD (Medicine)");
  await page.getByLabel("Registration number").fill("MMC/2026/0042");
  await page.getByLabel("Registration council").fill("Maharashtra Medical Council");
  await page.getByRole("button", { name: "Save profile" }).click();
  await expect(page.getByText("Saved.", { exact: true })).toBeVisible();

  await page.getByLabel("Signature").setInputFiles({ name: "sign.png", mimeType: "image/png", buffer: makePng(200, 60, [10, 10, 10]) });
  await page.getByRole("button", { name: "Upload" }).click();
  await expect(page.getByRole("img", { name: "Current signature" })).toBeVisible();
  expect(dialogs).toBe(0);
});

test("settings follow the role", async ({ page }) => {
  test.setTimeout(120_000);
  const other = await registerClinic(page, "padrole");
  try {
    await setRole(other.email, "doctor");
    await page.goto("/settings");
    await expect(page).toHaveURL(/\/settings\/profile$/);
    await expect(page.getByRole("link", { name: /my profile/i })).toBeVisible();

    await setRole(other.email, "reception");
    await page.goto("/settings/profile");
    await expect(page).toHaveURL(/\/dashboard/);
    await page.goto("/settings");
    await expect(page).toHaveURL(/\/dashboard/);
  } finally {
    await cleanupClinic(other.email);
  }
});
