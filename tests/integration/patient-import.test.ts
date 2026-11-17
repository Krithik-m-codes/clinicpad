// @vitest-environment node
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { adminDb } from "@/server/db/admin";
import { auditEvents, patientImports, patients, tenantCounters } from "@/server/db/schema";
import { createPatient } from "@/server/services/patients";
import { commitPatientImport, dryRunPatientImport, type ImportReport } from "@/server/services/patient-import";
import { DECODE_MESSAGES } from "@/lib/import/decode";
import { IMPORT_LIMITS, IMPORT_MESSAGES } from "@/lib/import/patient-rows";
import { NUL_MESSAGE } from "@/server/validation/text";
import { csv, utf16LeFile, utf8BomFile, utf8File } from "../helpers/csv-files";
import { commitInput } from "../helpers/patient-import";
import { createTestTenant, type TestTenant } from "../helpers/tenant";

let A: TestTenant;
let B: TestTenant;
const owner = () => A.as("owner");

async function dryRun(bytes: Uint8Array, mapping?: unknown): Promise<ImportReport> {
  const result = await dryRunPatientImport(owner(), { bytes }, mapping);
  if (!result.ok) throw new Error(result.message);
  return result.value;
}

async function commit(bytes: Uint8Array, decisions: Record<string, string> = {}, mapping?: unknown) {
  const report = await dryRun(bytes, mapping);
  return commitPatientImport(owner(), { bytes }, commitInput(report, decisions));
}

async function counter(tenantId: string): Promise<number> {
  const [row] = await adminDb.select().from(tenantCounters).where(and(eq(tenantCounters.tenantId, tenantId), eq(tenantCounters.name, "patient")));
  return row?.lastNo ?? 0;
}

beforeAll(async () => {
  A = await createTestTenant("import-a");
  B = await createTestTenant("import-b");
});

afterAll(async () => {
  await A.cleanup();
  await B.cleanup();
});

describe("who may import", () => {
  it("is the owner only, for the dry-run and the commit", async () => {
    const bytes = utf8File(csv(["name", "Role Test"]));
    for (const role of ["doctor", "reception", "nurse", "pharmacist", "accountant"]) {
      expect(await dryRunPatientImport(A.as(role), { bytes })).toMatchObject({ ok: false, code: "forbidden" });
      expect(await commitPatientImport(A.as(role), { bytes }, { mapping: null, decisions: {}, expectedSha256: "x", checkToken: "x", fingerprints: {} })).toMatchObject({ ok: false, code: "forbidden" });
    }
  });
});

describe("the sample template", () => {
  const template = readFileSync(path.join(process.cwd(), "sample_data", "patients_template.csv"));
  const bytes = new Uint8Array(template);

  it("checks clean, then imports with numbers that continue the clinic's sequence, audited by id", async () => {
    const before = await createPatient(owner(), { name: "Registered First" });
    if (!before.ok) throw new Error(before.message);
    const report = await dryRun(bytes);
    expect(report.totals).toEqual({ rows: 3, new: 3, duplicate: 0, alreadyImported: 0, invalid: 0 });
    expect(report.mapping).toEqual({ name: 0, phone: 1, dob: 2, gender: 3, address: 4, allergies: 5, notes: 6 });
    expect(report.rows.map((r) => r.status === "new" && r.dob)).toEqual(["1990-08-15", "1985-01-20", null]);

    const done = await commitPatientImport(owner(), { bytes }, commitInput(report));
    expect(done).toMatchObject({ ok: true, value: { created: 3, filled: 0, skipped: 0, alreadyImported: 0, invalid: 0 } });
    if (!done.ok) return;
    expect(done.value.firstPatientNo).toBe(before.value.patientNo + 1);
    expect(done.value.lastPatientNo).toBe(before.value.patientNo + 3);

    const rows = await adminDb.select().from(patients).where(eq(patients.importId, done.value.importId));
    expect(rows.map((r) => r.name).sort()).toEqual(["Asha Rao", "Ravi Kumar", "आशा देवी"].sort());
    expect(rows.find((r) => r.name === "Asha Rao")).toMatchObject({ phoneNormalized: "9000000001", dob: "1990-08-15", gender: "female", allergies: ["Penicillin", "Sulfa"] });
    expect(rows.every((r) => /^[0-9a-f]{64}$/.test(r.importRowKey ?? ""))).toBe(true);

    const [job] = await adminDb.select().from(patientImports).where(eq(patientImports.id, done.value.importId));
    expect(job).toMatchObject({ rowCount: 3, createdCount: 3, actorUserId: owner().userId });
    const events = await adminDb.select().from(auditEvents).where(eq(auditEvents.tenantId, A.tenantId));
    const created = events.filter((e) => e.action === "patient.created" && (e.after as { importId?: string } | null)?.importId === done.value.importId);
    expect(created).toHaveLength(3);
    expect(events.filter((e) => e.action === "patient_import.committed" && e.entityId === done.value.importId)).toHaveLength(1);
    expect(JSON.stringify(events)).not.toMatch(/Asha|Ravi|आशा|9000000001/);
  });

  it("is idempotent: a re-run reports every row as already imported, writes nothing, and burns no number", async () => {
    const lastNo = await counter(A.tenantId);
    const report = await dryRun(bytes);
    expect(report.totals).toMatchObject({ new: 0, alreadyImported: 3 });
    const done = await commitPatientImport(owner(), { bytes }, commitInput(report));
    expect(done).toMatchObject({ ok: true, value: { created: 0, alreadyImported: 3, firstPatientNo: null } });
    expect(await counter(A.tenantId)).toBe(lastNo);
  });
});

describe("two commits at once (a double-click, or two tabs)", () => {
  it("creates each patient once: the second waits for the first and finds its rows", async () => {
    const bytes = utf8File(csv(["name,phone", "Twin One,9000000101", "Twin Two,9000000102"]));
    const report = await dryRun(bytes);
    const input = commitInput(report);
    const [first, second] = await Promise.all([commitPatientImport(owner(), { bytes }, input), commitPatientImport(owner(), { bytes }, input)]);
    const created = [first, second].map((r) => (r.ok ? r.value.created : -1)).sort();
    expect(created).toEqual([0, 2]);
    const rows = await adminDb.select().from(patients).where(and(eq(patients.tenantId, A.tenantId), inArray(patients.name, ["Twin One", "Twin Two"])));
    expect(rows).toHaveLength(2);
  });
});

describe("duplicates", () => {
  const file = utf8File(
    csv([
      "name,phone,dob,gender,address,notes",
      "Meera Shah,+91 91234 56780,01/02/1980,F,5 Lake Road,Overwrite me?",
      "Kiran Shah,9123456780,,M,,",
      "Meera Shah,+91 91234 56780,01/02/1980,F,5 Lake Road,Overwrite me?",
    ]),
  );
  let meeraId = "";

  beforeAll(async () => {
    const meera = await createPatient(owner(), { name: "Meera Shah", phone: "91234 56780", notes: "Keep me" });
    if (!meera.ok) throw new Error(meera.message);
    meeraId = meera.value.id;
  });

  it("flags phone matches, a family member on the same phone, and an exact repeat inside the file", async () => {
    const report = await dryRun(file);
    expect(report.totals).toMatchObject({ rows: 3, duplicate: 3, new: 0 });
    const [meera, kiran, repeat] = report.rows;
    expect(meera).toMatchObject({ row: 2, status: "duplicate", canFill: true, canCreate: true, duplicateOfRow: null });
    expect(meera.status === "duplicate" && meera.matches).toEqual([{ patientNo: expect.any(Number), name: "Meera Shah", sameName: true, dob: null, gender: "unknown" }]);
    expect(kiran).toMatchObject({ row: 3, status: "duplicate", canFill: false, canCreate: true, duplicateOfRow: 2 });
    expect(repeat).toMatchObject({ row: 4, status: "duplicate", canFill: false, canCreate: false, duplicateOfRow: 2 });
  });

  it("skips every duplicate by default", async () => {
    expect(await commit(file)).toMatchObject({ ok: true, value: { created: 0, filled: 0, skipped: 3 } });
  });

  it("fills only empty details, never overwrites, creates a family member on request, and never creates an exact repeat", async () => {
    const done = await commit(file, { "2": "fill", "3": "create", "4": "create" });
    expect(done).toMatchObject({ ok: true, value: { created: 1, filled: 1, skipped: 1 } });
    const [meera] = await adminDb.select().from(patients).where(eq(patients.id, meeraId));
    expect(meera).toMatchObject({ name: "Meera Shah", dob: "1980-02-01", gender: "female", address: "5 Lake Road", notes: "Keep me" });
    const kirans = await adminDb.select().from(patients).where(and(eq(patients.tenantId, A.tenantId), eq(patients.name, "Kiran Shah")));
    expect(kirans).toHaveLength(1);
    const [fillEvent] = await adminDb
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.entityId, meeraId), eq(auditEvents.action, "patient.updated")));
    expect(fillEvent.after).toMatchObject({ changedFields: ["dob", "gender", "address"] });
  });

  it("ignores a fill request where filling is not offered", async () => {
    const other = utf8File(csv(["name,phone", "Someone Else,91234 56780"]));
    expect(await commit(other, { "2": "fill" })).toMatchObject({ ok: true, value: { filled: 0, created: 0, skipped: 1 } });
  });

  it("matches only this clinic's patients", async () => {
    const theirs = await createPatient(B.as("owner"), { name: "Other Clinic", phone: "9000000777" });
    if (!theirs.ok) throw new Error(theirs.message);
    const report = await dryRun(utf8File(csv(["name,phone", "Other Clinic,9000000777"])));
    expect(report.totals).toMatchObject({ new: 1, duplicate: 0 });
  });

  it("skips a row that became a duplicate after the check", async () => {
    const bytes = utf8File(csv(["name,phone", "Late Comer,9000011111"]));
    const report = await dryRun(bytes);
    expect(report.totals.new).toBe(1);
    await createPatient(A.as("reception"), { name: "Late Comer", phone: "9000011111" });
    const done = await commitPatientImport(owner(), { bytes }, commitInput(report));
    expect(done).toMatchObject({ ok: true, value: { created: 0, skipped: 1 } });
  });
});

describe("problem rows", () => {
  it("reports each problem with the spreadsheet row, the field, the message and the original cells", async () => {
    const nulName = "Bad\u0000Name";
    expect(nulName.codePointAt(3)).toBe(0);
    const report = await dryRun(
      utf8File(
        csv([
          "name,phone,dob,gender",
          `${nulName},,,`,
          "Future Baby,,01/01/2999,",
          "Sci Phone,9.87654E+09,,",
          "Robot,,,robot",
          ",9000000999,,",
          '"=HYPERLINK(""http://evil"")",,,',
        ]),
      ),
    );
    const problems = report.rows.filter((r) => r.status === "invalid");
    expect(problems.map((r) => r.status === "invalid" && [r.row, r.field, r.message])).toEqual([
      [2, "name", NUL_MESSAGE],
      [3, "dob", "Date of birth cannot be in the future"],
      [4, "phone", IMPORT_MESSAGES.sciPhone],
      [5, "gender", IMPORT_MESSAGES.gender],
      [6, "name", "Enter the patient's name"],
    ]);
    expect(problems[0].status === "invalid" && problems[0].cells).toEqual([nulName, "", "", ""]);
    // A formula-looking name is just text to ClinicPad; the problem-row download neutralises it (Task 7).
    expect(report.totals).toMatchObject({ rows: 6, invalid: 5, new: 1 });
  });
});

describe("file checks", () => {
  it.each([
    ["an empty file", new Uint8Array(), "Choose a CSV file first."],
    ["a file over 900 KB", new Uint8Array(IMPORT_LIMITS.maxBytes + 1).fill(0x41), IMPORT_MESSAGES.tooLarge],
    ["an Excel workbook", new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0]), DECODE_MESSAGES.workbook],
    ["Windows-1252 text", new Uint8Array([0x6e, 0x61, 0x6d, 0x65, 0x0a, 0x4a, 0x6f, 0x73, 0xe9]), DECODE_MESSAGES.notUtf8],
  ])("refuses %s with a message on the file field", async (_label, bytes, message) => {
    expect(await dryRunPatientImport(owner(), { bytes })).toEqual({ ok: false, code: "invalid", message, field: "file" });
  });

  it("reads Excel's Unicode Text (UTF-16, tab-separated) and keeps Devanagari intact", async () => {
    const bytes = utf16LeFile("Name\tMobile\r\nसुनीता वर्मा\t9000000201\r\n");
    const done = await commit(bytes);
    expect(done).toMatchObject({ ok: true, value: { created: 1 } });
    const [row] = await adminDb.select().from(patients).where(and(eq(patients.tenantId, A.tenantId), eq(patients.phoneNormalized, "9000000201")));
    expect(row.name).toBe("सुनीता वर्मा");
  });

  it("reads a semicolon file with a BOM", async () => {
    const report = await dryRun(utf8BomFile(csv(["Name;Phone", "Semi Colon;9000000301"])));
    expect(report.totals).toMatchObject({ new: 1 });
  });
});

describe("mapping, decisions and the file fingerprint", () => {
  it("asks for a name column when none is recognised, then uses the chosen one", async () => {
    const bytes = utf8File(csv(["Col A,Col B", "Unnamed Person,9000000401"]));
    const first = await dryRun(bytes);
    expect(first).toMatchObject({ needsName: true, rows: [], totals: { rows: 0 } });
    const second = await dryRun(bytes, { name: 0, phone: 1, dob: null, gender: null, address: null, allergies: null, notes: null });
    expect(second).toMatchObject({ needsName: false, totals: { new: 1 } });
  });

  it("refuses a changed file, a broken mapping, and broken decisions", async () => {
    const bytes = utf8File(csv(["name", "Fingerprint Person"]));
    const report = await dryRun(bytes);
    const changed = utf8File(csv(["name", "Fingerprint Persons"]));
    expect(await commitPatientImport(owner(), { bytes: changed }, commitInput(report))).toMatchObject({
      ok: false,
      code: "conflict",
    });
    expect(await commitPatientImport(owner(), { bytes }, { ...commitInput(report), mapping: { name: 5 } })).toMatchObject({
      ok: false,
      code: "invalid",
      field: "mapping",
    });
    expect(await commitPatientImport(owner(), { bytes }, commitInput(report, { "2": "merge" }))).toMatchObject({
      ok: false,
      code: "invalid",
      field: "decisions",
    });
  });
});
