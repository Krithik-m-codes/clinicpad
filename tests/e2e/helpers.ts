import { expect, type Page } from "@playwright/test";
import postgres from "postgres";

const adminUrl = process.env.ADMIN_DATABASE_URL ?? process.env.DIRECT_URL;

export type Clinic = { email: string; password: string; clinicName: string };

/** Signs up a fresh clinic through the UI and lands on the dashboard as its owner. */
export async function registerClinic(page: Page, label: string): Promise<Clinic> {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const clinic: Clinic = {
    email: `${label}-${stamp}@example.com`,
    password: "ClinicPad!2026",
    clinicName: `${label} Clinic ${stamp}`,
  };
  await page.goto("/signup");
  await page.getByLabel("Clinic name").fill(clinic.clinicName);
  await page.getByLabel("Your name").fill("Dr. E2E Tester");
  await page.getByLabel("Email").fill(clinic.email);
  await page.getByLabel("Phone").fill(`9${stamp.slice(-9)}`);
  await page.getByLabel("Password").fill(clinic.password);
  await page.getByRole("button", { name: /create clinic/i }).click();
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 30_000 });
  return clinic;
}

/** Removes the clinic (cascades to patients, prescriptions, audit) and its user. */
export async function cleanupClinic(email: string): Promise<void> {
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
}
