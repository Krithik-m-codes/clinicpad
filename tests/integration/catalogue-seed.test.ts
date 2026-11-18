import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq, like } from "drizzle-orm";
import { adminDb } from "@/server/db/admin";
import { globalClinicalTerms, globalMedicines } from "@/server/db/schema";
import { seedCatalogue } from "@/server/db/catalogue-seed";

const stamp = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const P = `ZZSEED${stamp}`;
const key = P.toLowerCase();
let dir = "";

async function writeFixtures(betaGeneric: string) {
  await writeFile(
    path.join(dir, "medicines_template.csv"),
    "\ufeffname,salt\r\n" +
      `${P} ALPHA TAB,Alpha 10mg\r\n` +
      `${key}   alpha tab,Duplicate is ignored\r\n` +
      `"${P} BETA SYRUP","${betaGeneric}"\r\n` +
      ",Salt without a name\r\n" +
      `${P} ${"X".repeat(250)},Name too long\r\n` +
      `${P} आयुर्वेद चूर्ण,Herbal\r\n`,
    "utf8",
  );
  await writeFile(path.join(dir, "complaints_template.csv"), `name\r\n${P} ITCH\r\n${key} itch\r\n`, "utf8");
  await writeFile(path.join(dir, "diagnosis_template.csv"), `name,icdCode\r\n${P} SCABIES,B86\r\n`, "utf8");
  await writeFile(path.join(dir, "medical_history_template.csv"), `name\r\n${P} ASTHMA\r\n`, "utf8");
  await writeFile(path.join(dir, "tests_template.csv"), `name\r\n${P} SKIN SCRAPING\r\n`, "utf8");
}

const fixtureMedicines = () =>
  adminDb.select().from(globalMedicines).where(like(globalMedicines.nameKey, `${key}%`));

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "clinicpad-seed-"));
});

afterAll(async () => {
  await adminDb.delete(globalMedicines).where(like(globalMedicines.nameKey, `${key}%`));
  await adminDb.delete(globalClinicalTerms).where(like(globalClinicalTerms.nameKey, `${key}%`));
  await rm(dir, { recursive: true, force: true });
});

describe("seedCatalogue", () => {
  it("loads fixture files, de-duplicating names and skipping blank or oversized rows", async () => {
    await writeFixtures("Gamma 5mg, Delta 2mg");
    const report = await seedCatalogue(dir);
    expect(report).toEqual({
      medicines: 3,
      terms: { complaint: 1, diagnosis: 1, history: 1, test: 1 },
      skipped: 2,
    });

    const rows = await fixtureMedicines();
    expect(rows.map((r) => r.name).sort()).toEqual([`${P} ALPHA TAB`, `${P} BETA SYRUP`, `${P} आयुर्वेद चूर्ण`].sort());
    expect(rows.find((r) => r.name === `${P} ALPHA TAB`)?.genericName).toBe("Alpha 10mg");
    expect(rows.find((r) => r.name === `${P} BETA SYRUP`)?.genericName).toBe("Gamma 5mg, Delta 2mg");

    const [scabies] = await adminDb
      .select()
      .from(globalClinicalTerms)
      .where(and(eq(globalClinicalTerms.kind, "diagnosis"), like(globalClinicalTerms.nameKey, `${key}%`)));
    expect(scabies.icd10Code).toBe("B86");
  });

  it("is idempotent and picks up edited generic names", async () => {
    await writeFixtures("Gamma 7mg");
    await seedCatalogue(dir);
    await seedCatalogue(dir);
    const rows = await fixtureMedicines();
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.name === `${P} BETA SYRUP`)?.genericName).toBe("Gamma 7mg");
  });

  it("loads the real sample_data catalogue", async () => {
    const report = await seedCatalogue();
    expect(report).toEqual({
      medicines: 1897,
      terms: { complaint: 139, diagnosis: 119, history: 80, test: 96 },
      skipped: 0,
    });
    const [dolo] = await adminDb.select().from(globalMedicines).where(eq(globalMedicines.nameKey, "dolo 650mg"));
    expect(dolo).toMatchObject({ name: "DOLO 650MG", genericName: "Paracetamol 650Mg" });
    const [anticramp] = await adminDb.select().from(globalMedicines).where(eq(globalMedicines.nameKey, "anticramp tab"));
    expect(anticramp.genericName).toContain("L-Carnitine 500mg");
    const fever = await adminDb
      .select()
      .from(globalClinicalTerms)
      .where(and(eq(globalClinicalTerms.kind, "complaint"), eq(globalClinicalTerms.nameKey, "fever")));
    expect(fever).toHaveLength(1);
  });
});
