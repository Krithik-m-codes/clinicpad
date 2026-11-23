import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { makeLetterheadPng } from "../helpers/images";
import { minimalPdf } from "../helpers/pdfs";
import { cleanupClinic, completeProfile, ensureCatalogue, finalizeDraft, registerClinic, registerPatient, setRole, startDraft, type Clinic } from "./helpers";

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

test("an owner turns a scanned pad into a template, publishes it, and prints a prescription on it", async ({ page, browser }) => {
  test.setTimeout(300_000);
  const withPdf = await gotenbergUp();
  const started = Date.now();
  await page.addInitScript(() => {
    const top = window.top as unknown as { __printCalls?: number };
    top.__printCalls = top.__printCalls ?? 0;
    window.print = () => {
      top.__printCalls = (top.__printCalls ?? 0) + 1;
      window.dispatchEvent(new Event("afterprint"));
    };
  });
  const clinic = await registerClinic(page, "tpl-e2e");
  clinics.push(clinic);
  await completeProfile(page);

  await page.goto("/templates/new");
  await page.getByRole("radio", { name: /Photo or scan/ }).check();
  await page.getByLabel("Choose the photo or scan").setInputFiles({ name: "pad.png", mimeType: "image/png", buffer: makeLetterheadPng(1240, 1754, 297) });
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Place the boxes" }).click();
  await expect(page).toHaveURL(/\/templates\/[0-9a-f-]{36}$/);

  const nameBox = page.getByRole("button", { name: /Patient's name box/ });
  await nameBox.focus();
  await page.keyboard.press("ArrowRight");
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByRole("button", { name: "Saved" })).toBeVisible();

  const [preview] = await Promise.all([page.waitForEvent("popup"), page.getByRole("link", { name: "12 medicines (page 2)" }).click()]);
  await expect(preview.locator("table.flow")).toBeAttached();
  await expect(preview.locator(".banner-sample")).toBeVisible();
  await preview.screenshot({ path: path.join("test-results", "templates-e2e-sample-preview.png"), fullPage: true });
  await preview.close();

  await page.getByRole("radio", { name: /does not show a doctor/ }).check();
  await page.getByRole("button", { name: "Publish" }).click();
  await expect(page.getByText(/^Published\./)).toBeVisible();
  await page.getByRole("button", { name: "Use for the whole clinic" }).click();
  await expect(page.getByText(/Every prescription now prints on this pad/)).toBeVisible();
  test.info().annotations.push({ type: "setup-seconds", description: String(Math.round((Date.now() - started) / 1000)) });

  const patientUrl = await registerPatient(page, "Template E2E Patient");
  await startDraft(page, patientUrl);
  const rxUrl = await finalizeDraft(page, "Paracetamol", /Rx #1/);
  // The print frame is removed on afterprint (the stub fires it at once), so read what the print route served.
  const [printed] = await Promise.all([
    page.waitForResponse((r) => r.url().includes("/document?purpose=print")),
    page.getByRole("button", { name: /^print$/i }).click(),
  ]);
  expect(printed.status()).toBe(200);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __printCalls?: number }).__printCalls ?? 0)).toBe(1);
  const printMarkup = await printed.text();
  expect(printMarkup).toMatch(/<table class="flow"/);
  expect(printMarkup).toMatch(/<div class="box box-0"><span class="v">Template E2E Patient<\/span>/);
  expect(printMarkup).not.toContain("<script");

  // The pad is pinned: the saved preview of the finalized prescription is the overlay pad.
  const document = await (await page.request.get(`${rxUrl}/document?purpose=preview`)).text();
  expect(document).toContain("table");
  expect(document).toContain("Template E2E Patient");

  if (withPdf) {
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download PDF" }).click()]);
    expect(download.suggestedFilename()).toBe("Rx-1-v1.pdf");
    const pdf = readFileSync(await download.path());
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  } else {
    test.info().annotations.push({ type: "note", description: "Gotenberg is down: the PDF download part was skipped" });
  }

  // Sharing: the link opens the pinned pad (a PDF); a fresh browser has no session.
  await page.goto("/settings");
  await page.getByRole("checkbox", { name: /Allow sharing prescriptions/ }).check();
  await page.getByRole("button", { name: "Save sharing" }).click();
  await expect(page.getByText("Saved.", { exact: true }).last()).toBeVisible();
  await page.goto(patientUrl);
  await page.getByRole("link", { name: /Rx #1/ }).first().click();
  const share = page.getByRole("region", { name: "Share with the patient" });
  await share.getByLabel("Verbal").check();
  await share.getByLabel("The patient (or their guardian) agreed to this text.").check();
  await share.getByRole("button", { name: "Record consent" }).click();
  await share.getByLabel("WhatsApp number").fill("98765 43210");
  await share.getByRole("button", { name: "Create WhatsApp message" }).click();
  const href = (await share.getByRole("link", { name: "Open WhatsApp" }).getAttribute("href")) ?? "";
  const shareUrl = /https?:\/\/\S+\/s\/[A-Za-z0-9_-]{43}/.exec(new URL(href).searchParams.get("text") ?? "")?.[0] ?? "";
  expect(shareUrl).not.toBe("");
  const visitorContext = await browser.newContext();
  const visitor = await visitorContext.newPage();
  await visitor.goto(shareUrl);
  const [response] = await Promise.all([
    visitor.waitForResponse((r) => r.request().method() === "POST" && r.url().includes("/s/")),
    visitor.getByRole("button", { name: "Open prescription (PDF)" }).click(),
  ]);
  if (withPdf) {
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toBe("application/pdf");
  } else {
    expect(response.status()).toBe(503);
  }
  await visitorContext.close();

  // Cross-role denials: a designer reads the template but never a prescription, its document or its PDF.
  await setRole(clinic.email, "designer");
  for (const route of [`${rxUrl}/document?purpose=preview`, `${rxUrl}/pdf`]) {
    const denied = await page.request.get(route, { maxRedirects: 0 });
    expect([302, 303, 307, 403, 404], `${route} -> ${denied.status()}`).toContain(denied.status());
  }
  await page.goto(rxUrl);
  await expect(page.getByRole("heading", { name: /Rx #1/ })).toHaveCount(0);
  await page.goto("/templates");
  await expect(page).toHaveURL(/\/templates$/, { timeout: 60_000 });
});

test("a PDF pad is read in the sandboxed frame and becomes a template", async ({ page }) => {
  test.setTimeout(180_000);
  clinics.push(await registerClinic(page, "tpl-e2e-pdf"));
  await page.goto("/templates/new");
  // Warm the (dev-compiled) frame route: the wizard fails fast when the frame is slow to answer.
  await page.request.get("/pdf-frame/frame.html");
  await page.getByRole("radio", { name: /^PDF/ }).check();
  await page.getByLabel("Choose the PDF").setInputFiles({ name: "pad.pdf", mimeType: "application/pdf", buffer: minimalPdf(595.28, 841.89, "E2E PAD") });
  await expect(page.getByRole("button", { name: "Continue" })).toBeEnabled({ timeout: 90_000 });
  await expect(page.getByLabel("Paper size of this pad")).toHaveValue("A4");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Place the boxes" }).click();
  await expect(page).toHaveURL(/\/templates\/[0-9a-f-]{36}$/);
});

test("a real Devanagari Word-style PDF fixture becomes a template", async ({ page }) => {
  test.setTimeout(180_000);
  clinics.push(await registerClinic(page, "tpl-e2e-dev"));
  await page.goto("/templates/new");
  // Warm the (dev-compiled) frame route: the wizard fails fast when the frame is slow to answer.
  await page.request.get("/pdf-frame/frame.html");
  await page.getByRole("radio", { name: /^PDF/ }).check();
  await page.getByLabel("Choose the PDF").setInputFiles({
    name: "pad.pdf",
    mimeType: "application/pdf",
    buffer: readFileSync(path.join(process.cwd(), "tests", "fixtures", "pdf-intake", "devanagari-docx-libreoffice.pdf")),
  });
  await expect(page.getByRole("button", { name: "Continue" })).toBeEnabled({ timeout: 90_000 });
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Place the boxes" }).click();
  await expect(page).toHaveURL(/\/templates\/[0-9a-f-]{36}$/);
});

test("reception cannot open Template Studio; a designer can, and sees no patients", async ({ page }) => {
  test.setTimeout(240_000);
  test.slow();
  // A redirect can replace the first navigation (ERR_ABORTED); anything else is a real failure.
  const visit = (url: string) =>
    page.goto(url).catch((error: Error) => {
      if (!/ERR_ABORTED/.test(error.message)) throw error;
    });
  const clinic = await registerClinic(page, "tpl-e2e-roles");
  clinics.push(clinic);
  await setRole(clinic.email, "reception");
  await page.goto("/dashboard");
  await expect(page.getByRole("link", { name: "Pad templates" })).toHaveCount(0);
  await page.goto("/templates");
  await expect(page).toHaveURL(/\/dashboard$/, { timeout: 60_000 });
  await visit("/templates/new");
  await expect(page).not.toHaveURL(/\/templates\/new$/);
  await setRole(clinic.email, "designer");
  // The dashboard redirects a designer; an aborted first navigation is the redirect replacing it.
  await visit("/dashboard");
  await expect(page).toHaveURL(/\/templates$/, { timeout: 60_000 });
  await visit("/patients");
  await expect(page).not.toHaveURL(/\/patients$/);
  await visit("/patients/new");
  await expect(page).not.toHaveURL(/\/patients\/new$/);
});
