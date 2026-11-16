import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { sql } from "drizzle-orm";
import { adminDb } from "@/server/db/admin";
import { globalClinicalTerms, globalMedicines } from "@/server/db/schema";
import { csvRecords } from "@/lib/csv";
import { catalogueKey } from "@/lib/domain/search";
import { cleanText } from "@/lib/domain/text";
import type { TermKind } from "@/lib/domain/rx-options";

const TERM_FILES: ReadonlyArray<{ kind: TermKind; file: string }> = [
  { kind: "complaint", file: "complaints_template.csv" },
  { kind: "diagnosis", file: "diagnosis_template.csv" },
  { kind: "history", file: "medical_history_template.csv" },
  { kind: "test", file: "tests_template.csv" },
];

const MAX_NAME = 200;
const MAX_GENERIC = 300;
const MAX_ICD = 16;
const CHUNK = 500;

export type CatalogueSeedReport = { medicines: number; terms: Record<TermKind, number>; skipped: number };

function tidy(value: string | undefined): string {
  return cleanText(value ?? "").replace(/\s+/g, " ").trim();
}

function chunks<T>(rows: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

/**
 * Loads the global reference catalogue from the sample_data CSVs. Idempotent: rows are
 * keyed by a normalized name, so re-running updates generic names and ICD codes instead
 * of duplicating rows; the first spelling of a duplicated name wins. Uses the admin
 * connection because the app role can only read these tables. Safe in production: this
 * is reference data, not patient data.
 */
export async function seedCatalogue(dir = path.join(process.cwd(), "sample_data")): Promise<CatalogueSeedReport> {
  let skipped = 0;

  const medicines = new Map<string, { name: string; genericName: string | null; nameKey: string }>();
  for (const record of csvRecords(await readFile(path.join(dir, "medicines_template.csv"), "utf8"))) {
    const name = tidy(record.name);
    if (!name || name.length > MAX_NAME) {
      skipped += 1;
      continue;
    }
    const nameKey = catalogueKey(name);
    const generic = tidy(record.salt).slice(0, MAX_GENERIC);
    if (!medicines.has(nameKey)) medicines.set(nameKey, { name, genericName: generic || null, nameKey });
  }
  for (const chunk of chunks([...medicines.values()], CHUNK)) {
    await adminDb
      .insert(globalMedicines)
      .values(chunk)
      .onConflictDoUpdate({
        target: globalMedicines.nameKey,
        set: { name: sql`excluded.name`, genericName: sql`excluded.generic_name` },
      });
  }

  const terms: Record<TermKind, number> = { complaint: 0, diagnosis: 0, history: 0, test: 0 };
  for (const { kind, file } of TERM_FILES) {
    const rows = new Map<string, { kind: TermKind; name: string; nameKey: string; icd10Code: string | null }>();
    for (const record of csvRecords(await readFile(path.join(dir, file), "utf8"))) {
      const name = tidy(record.name);
      if (!name || name.length > MAX_NAME) {
        skipped += 1;
        continue;
      }
      const nameKey = catalogueKey(name);
      const icd = tidy(record.icdcode).slice(0, MAX_ICD);
      if (!rows.has(nameKey)) rows.set(nameKey, { kind, name, nameKey, icd10Code: icd || null });
    }
    for (const chunk of chunks([...rows.values()], CHUNK)) {
      await adminDb
        .insert(globalClinicalTerms)
        .values(chunk)
        .onConflictDoUpdate({
          target: [globalClinicalTerms.kind, globalClinicalTerms.nameKey],
          set: { name: sql`excluded.name`, icd10Code: sql`excluded.icd10_code` },
        });
    }
    terms[kind] = rows.size;
  }

  return { medicines: medicines.size, terms, skipped };
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  seedCatalogue()
    .then((report) => {
      console.log(
        `Catalogue seeded: ${report.medicines} medicines; terms ${JSON.stringify(report.terms)}; skipped ${report.skipped} rows`,
      );
      process.exit(0);
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
