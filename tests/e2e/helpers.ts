import { expect, type Page } from "@playwright/test";
import { execSync } from "node:child_process";
import postgres from "postgres";

const adminUrl = process.env.ADMIN_DATABASE_URL ?? process.env.DIRECT_URL;

export type Clinic = { email: string; password: string; clinicName: string };

function requireAdminUrl(): string {
  if (!adminUrl) {
    throw new Error(
      "ADMIN_DATABASE_URL (or DIRECT_URL) is not set; e2e tests need it to clean up their clinics.",
    );
  }
  return adminUrl;
}

/** Runs `work` against the database as the admin role (bypasses RLS). */
export async function withAdminSql<T>(work: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const sql = postgres(requireAdminUrl(), { max: 1 });
  try {
    return await work(sql);
  } finally {
    await sql.end();
  }
}

/**
 * Signs up a fresh clinic through the UI and lands on the dashboard as its owner.
 * If sign-up fails part-way the half-created clinic is removed before the error is rethrown.
 */
export async function registerClinic(page: Page, label: string): Promise<Clinic> {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const clinic: Clinic = {
    email: `${label}-${stamp}@example.com`,
    password: "ClinicPad!2026",
    clinicName: `${label} Clinic ${stamp}`,
  };
  try {
    await page.goto("/signup");
    await page.getByLabel("Clinic name").fill(clinic.clinicName);
    await page.getByLabel("Your name").fill("Dr. E2E Tester");
    await page.getByLabel("Email").fill(clinic.email);
    await page.getByLabel("Phone").fill(`9${stamp.slice(-9)}`);
    await page.getByLabel("Password").fill(clinic.password);
    await page.getByRole("button", { name: /create clinic/i }).click();
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 30_000 });
  } catch (error) {
    await cleanupClinic(clinic.email).catch(() => undefined);
    throw error;
  }
  return clinic;
}

/** Removes the clinic (cascades to patients, prescriptions, audit) and its user. */
export async function cleanupClinic(email: string): Promise<void> {
  await withAdminSql(async (sql) => {
    await sql`delete from tenants where id in (
      select m.tenant_id from memberships m join users u on u.id = m.user_id where u.email = ${email}
    )`;
    await sql`delete from users where email = ${email}`;
  });
}

/** Changes the role of the clinic's signed-in user; roles are re-read on every request. */
export async function setRole(email: string, role: string): Promise<void> {
  await withAdminSql(async (sql) => {
    await sql`update memberships set role = ${role},
      expires_at = case when ${role} = 'designer' then now() + interval '7 days' else null end
      where user_id = (select id from users where email = ${email})`;
  });
}

/**
 * Inserts `count` patients straight into the clinic (newest = highest number) for paging tests. The numbers are
 * reserved through tenant_counters, exactly like allocateNumbers, so a patient registered afterwards continues the sequence.
 */
export async function seedPatients(email: string, count: number): Promise<void> {
  await withAdminSql(async (sql) => {
    await sql.begin(async (tx) => {
      const [member] = await tx<{ tenant_id: string }[]>`
        select m.tenant_id from memberships m join users u on u.id = m.user_id where u.email = ${email} limit 1`;
      if (!member) throw new Error("seedPatients: no clinic for that email");
      const [counter] = await tx<{ last_no: number }[]>`
        insert into tenant_counters (tenant_id, name, last_no) values (${member.tenant_id}, 'patient', ${count})
        on conflict (tenant_id, name) do update set last_no = tenant_counters.last_no + ${count}
        returning last_no`;
      const first = counter.last_no - count + 1;
      await tx`insert into patients (id, tenant_id, patient_no, name, created_at)
        select gen_random_uuid(), ${member.tenant_id}, ${first}::int - 1 + g, 'Seed Patient ' || lpad(g::text, 3, '0'),
               now() - ((${count}::int - g) * interval '1 minute')
          from generate_series(1, ${count}::int) as g`;
    });
  });
}

/** The editor's search needs the global catalogue. Seeds it once if this database lacks it. */
export async function ensureCatalogue(): Promise<void> {
  const seeded = await withAdminSql(async (sql) => {
    const rows = await sql<{ n: number }[]>`select count(*)::int as n from global_medicines where name_key = 'dolo 650mg'`;
    return rows[0].n > 0;
  });
  if (!seeded) execSync("npm run db:seed:catalogue", { stdio: "inherit" });
}

/**
 * The clinical editor is disabled until it has hydrated (text typed into server-rendered inputs
 * would be lost). Wait for it before typing.
 */
export async function waitForEditor(page: Page): Promise<void> {
  await expect(page.getByLabel("Chief complaint")).toBeEditable({ timeout: 15_000 });
}
