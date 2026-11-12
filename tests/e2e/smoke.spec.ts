import { expect, test } from "@playwright/test";
import postgres from "postgres";

const adminUrl = process.env.ADMIN_DATABASE_URL ?? process.env.DIRECT_URL;

test("health endpoint reports ok", async ({ request }) => {
  const response = await request.get("/api/health");
  expect(response.ok()).toBe(true);
  expect(await response.json()).toMatchObject({ status: "ok" });
});

test("login page renders", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: /sign in to clinicpad/i })).toBeVisible();
  await expect(page.getByLabel("Email")).toBeVisible();
  await expect(page.getByLabel("Password")).toBeVisible();
});

test("signup page renders", async ({ page }) => {
  await page.goto("/signup");
  await expect(page.getByRole("heading", { name: /create your clinic/i })).toBeVisible();
  await expect(page.getByLabel("Clinic name")).toBeVisible();
});

test("unauthenticated visitors are sent to login", async ({ page }) => {
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/login/);
  await page.goto("/settings");
  await expect(page).toHaveURL(/\/login/);
});

test.describe("clinic sign-up flow", () => {
  const stamp = Date.now();
  const email = `e2e-${stamp}@example.com`;
  const phone = `9${String(stamp).slice(-9)}`;
  const clinicName = `E2E Clinic ${stamp}`;
  const password = "ClinicPad!2026";

  test.afterAll(async () => {
    if (!adminUrl) return;
    const sql = postgres(adminUrl, { max: 1 });
    try {
      await sql`delete from tenants where id in (
        select m.tenant_id from memberships m join users u on u.id = m.user_id where u.email = ${email}
      )`;
      await sql`delete from users where email = ${email}`;
    } finally {
      await sql.end();
    }
  });

  test("sign up, see dashboard and settings, sign out, sign back in", async ({ page }) => {
    await page.goto("/signup");
    await page.getByLabel("Clinic name").fill(clinicName);
    await page.getByLabel("Your name").fill("Dr. E2E Tester");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Phone").fill(phone);
    await page.getByLabel("Password").fill(password);
    await page.getByLabel("City").fill("Pune");
    await page.getByRole("button", { name: /create clinic/i }).click();

    await expect(page).toHaveURL(/\/dashboard/, { timeout: 30_000 });
    await expect(page.getByRole("heading", { name: clinicName })).toBeVisible();

    // Owner sees Settings.
    await page.getByRole("link", { name: "Settings" }).click();
    await expect(page.getByRole("heading", { name: /clinic settings/i })).toBeVisible();
    await expect(page.getByText("Asia/Kolkata")).toBeVisible();

    // Sign out ends the session.
    await page.getByRole("button", { name: /sign out/i }).click();
    await expect(page).toHaveURL(/\/login/);
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/login/);

    // Sign back in.
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: /^sign in$/i }).click();
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 30_000 });
    await expect(page.getByRole("heading", { name: clinicName })).toBeVisible();

    // Role changes apply to the live session: demote to reception in the database.
    expect(adminUrl).toBeTruthy();
    const sql = postgres(adminUrl!, { max: 1 });
    try {
      await sql`update memberships set role = 'reception'
        where user_id = (select id from users where email = ${email})`;
    } finally {
      await sql.end();
    }

    await page.goto("/settings");
    await expect(page).toHaveURL(/\/dashboard/);
    await expect(page.getByRole("link", { name: "Settings" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Patients" })).toBeVisible();
  });

  test("wrong password shows an error", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Email").fill("nobody@example.com");
    await page.getByLabel("Password").fill("not-a-real-password");
    await page.getByRole("button", { name: /^sign in$/i }).click();
    await expect(page.getByText("Invalid email or password.")).toBeVisible();
  });
});
