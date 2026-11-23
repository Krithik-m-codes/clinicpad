import { expect, test, type Page } from "@playwright/test";
import { cleanupClinic, ensureCatalogue, registerClinic, setRole, waitForEditor, withAdminSql, type Clinic } from "./helpers";

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

async function finalizedPrescription(page: Page, name: string, phone: string): Promise<{ rxUrl: string; patientUrl: string }> {
  await page.goto("/patients/new");
  await page.getByLabel("Name").fill(name);
  await page.getByLabel("Phone").fill(phone);
  await page.getByRole("button", { name: /register patient/i }).click();
  await expect(page.getByRole("heading", { name })).toBeVisible();
  const patientUrl = page.url();
  await page.getByRole("button", { name: /new prescription/i }).click();
  await waitForEditor(page);
  await page.getByLabel("Medicine name").first().fill("Paracetamol");
  await page.getByRole("button", { name: /^finalize$/i }).click();
  await expect(page.getByRole("heading", { name: /Rx #1/ })).toBeVisible({ timeout: 15_000 });
  return { rxUrl: page.url(), patientUrl };
}

test("share a prescription by WhatsApp after consent; the patient opens it signed out; withdrawing stops it", async ({ page, browser }) => {
  test.setTimeout(180_000);
  const withPdf = await gotenbergUp();
  const clinic = await registerClinic(page, "share");
  clinics.push(clinic);

  // Off by default: the owner turns it on.
  await page.goto("/settings");
  await page.getByRole("checkbox", { name: /Allow sharing prescriptions/ }).check();
  await page.getByRole("button", { name: "Save sharing" }).click();
  await expect(page.getByText("Saved.", { exact: true }).last()).toBeVisible();

  const { rxUrl, patientUrl } = await finalizedPrescription(page, "Meena Share", "98765 43210");
  const share = page.getByRole("region", { name: "Share with the patient" });
  await share.getByLabel("Verbal").check();
  await share.getByLabel("The patient (or their guardian) agreed to this text.").check();
  await share.getByRole("button", { name: "Record consent" }).click();
  await expect(share.getByLabel("WhatsApp number")).toHaveValue("98765 43210");

  await share.getByRole("button", { name: "Create WhatsApp message" }).click();
  const openWhatsApp = share.getByRole("link", { name: "Open WhatsApp" });
  await expect(openWhatsApp).toHaveAttribute("href", /^https:\/\/wa\.me\/919876543210\?text=/);
  await expect(openWhatsApp).toHaveAttribute("target", "_blank");
  const href = (await openWhatsApp.getAttribute("href")) ?? "";
  const text = new URL(href).searchParams.get("text") ?? "";
  expect(text).not.toContain("Meena");
  const shareUrl = /https?:\/\/\S+\/s\/[A-Za-z0-9_-]{43}/.exec(text)?.[0] ?? "";
  expect(shareUrl).not.toBe("");

  // The patient, signed out: an interstitial with no details, then the PDF.
  const visitorContext = await browser.newContext();
  const visitor = await visitorContext.newPage();
  await visitor.goto(shareUrl);
  await expect(visitor.getByRole("heading", { name: "Your prescription" })).toBeVisible();
  await expect(visitor.getByText("Meena")).toHaveCount(0);
  const [response] = await Promise.all([
    visitor.waitForResponse((r) => r.request().method() === "POST" && r.url().includes("/s/")),
    visitor.getByRole("button", { name: "Open prescription (PDF)" }).click(),
  ]);
  if (withPdf) {
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toBe("application/pdf");
    await page.goto(rxUrl);
    await expect(page.getByText(/opened 1 of 10/)).toBeVisible();
  } else {
    expect(response.status()).toBe(503);
  }

  // Withdraw the link: the visitor's copy stops at once.
  await page.goto(rxUrl);
  await page.getByRole("button", { name: "Withdraw link" }).click();
  await expect(page.getByText(/withdrawn/)).toBeVisible();
  await visitor.goto(shareUrl);
  await expect(visitor.getByRole("heading", { name: "This link is not valid" })).toBeVisible();
  await visitorContext.close();

  // Withdrawing consent removes the way to share.
  await page.goto(patientUrl);
  await page.getByRole("button", { name: "Withdraw consent" }).click();
  await page.getByRole("button", { name: "Yes, withdraw consent" }).click();
  await expect(page.getByText(/^Withdrawn on/)).toBeVisible();
  await page.goto(rxUrl);
  await expect(page.getByRole("button", { name: "Create WhatsApp message" })).toHaveCount(0);

  // Nurses never see the panel.
  await setRole(clinic.email, "nurse");
  await page.goto(rxUrl);
  await expect(page.getByRole("heading", { name: "Share with the patient" })).toHaveCount(0);
});

async function enableSharingAndConsent(page: Page, rxUrl: string): Promise<void> {
  await page.goto("/settings");
  await page.getByRole("checkbox", { name: /Allow sharing prescriptions/ }).check();
  await page.getByRole("button", { name: "Save sharing" }).click();
  await expect(page.getByText("Saved.", { exact: true }).last()).toBeVisible();
  await page.goto(rxUrl);
  const share = page.getByRole("region", { name: "Share with the patient" });
  await share.getByLabel("Verbal").check();
  await share.getByLabel("The patient (or their guardian) agreed to this text.").check();
  await share.getByRole("button", { name: "Record consent" }).click();
  await expect(share.getByLabel("WhatsApp number")).toBeVisible();
}

async function newShareUrl(page: Page): Promise<string> {
  const share = page.getByRole("region", { name: "Share with the patient" });
  await share.getByRole("button", { name: "Create WhatsApp message" }).click();
  const href = (await share.getByRole("link", { name: "Open WhatsApp" }).getAttribute("href")) ?? "";
  const text = new URL(href).searchParams.get("text") ?? "";
  const url = /https?:\/\/\S+\/s\/[A-Za-z0-9_-]{43}/.exec(text)?.[0] ?? "";
  expect(url).not.toBe("");
  return url;
}

test("an expired link and a link whose consent was withdrawn both say: This link is not valid", async ({ page, browser }) => {
  test.setTimeout(180_000);
  const clinic = await registerClinic(page, "sharegone");
  clinics.push(clinic);
  const { rxUrl, patientUrl } = await finalizedPrescription(page, "Gone Share", "98765 43210");
  await enableSharingAndConsent(page, rxUrl);

  const visitorContext = await browser.newContext();
  const visitor = await visitorContext.newPage();

  const expiring = await newShareUrl(page);
  await visitor.goto(expiring);
  await expect(visitor.getByRole("heading", { name: "Your prescription" })).toBeVisible();
  // Expired a moment after it was created. The immutability trigger forbids this on purpose, so the test turns it
  // off inside ONE transaction (DDL is transactional: the trigger is back on when it commits; nobody sees it off).
  await withAdminSql((sql) =>
    sql.begin(async (tx) => {
      await tx`alter table share_links disable trigger share_links_rules`;
      await tx`update share_links set expires_at = created_at + interval '1 second'
        where tenant_id = (select m.tenant_id from memberships m join users u on u.id = m.user_id where u.email = ${clinic.email})`;
      await tx`alter table share_links enable trigger share_links_rules`;
    }),
  );
  // The link expires one second after creation; on a fast machine that moment may not have passed yet.
  await page.waitForTimeout(1500);
  await visitor.goto(expiring);
  await expect(visitor.getByRole("heading", { name: "This link is not valid" })).toBeVisible();

  await page.goto(rxUrl);
  const alive = await newShareUrl(page);
  await visitor.goto(alive);
  await expect(visitor.getByRole("heading", { name: "Your prescription" })).toBeVisible();
  await page.goto(patientUrl);
  await page.getByRole("button", { name: "Withdraw consent" }).click();
  await page.getByRole("button", { name: "Yes, withdraw consent" }).click();
  await expect(page.getByText(/^Withdrawn on/)).toBeVisible();
  await visitor.goto(alive);
  await expect(visitor.getByRole("heading", { name: "This link is not valid" })).toBeVisible();
  await visitorContext.close();
});

test("a nurse cannot share, even by opening the page directly", async ({ page }) => {
  test.setTimeout(120_000);
  const clinic = await registerClinic(page, "sharenurse");
  clinics.push(clinic);
  const { rxUrl } = await finalizedPrescription(page, "Nurse Check", "98765 43210");
  await enableSharingAndConsent(page, rxUrl);
  await setRole(clinic.email, "nurse");
  await page.goto(rxUrl);
  await expect(page.getByRole("heading", { name: "Share with the patient" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Create WhatsApp message" })).toHaveCount(0);
});
