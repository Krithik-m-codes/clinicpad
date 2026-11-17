// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/auth/session", () => ({ requireSession: vi.fn(), getSessionContext: vi.fn() }));
vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { requireSession } from "@/server/auth/session";
import { commitImportAction, dryRunImportAction } from "@/server/actions/patient-import";
import { IMPORT_LIMITS, IMPORT_MESSAGES } from "@/lib/import/patient-rows";
import { csv } from "../helpers/csv-files";
import { createTestTenant, type TestTenant } from "../helpers/tenant";

const session = vi.mocked(requireSession);
let A: TestTenant;

const file = (text: string) => new File([text], "patients.csv", { type: "text/csv" });
function form(values: Record<string, string | File>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.append(key, value);
  return data;
}

beforeAll(async () => {
  A = await createTestTenant("import-act");
});
afterAll(async () => {
  await A.cleanup();
});
beforeEach(() => {
  session.mockResolvedValue(A.as("owner"));
});

describe("the import actions", () => {
  it("refuse a file over the size cap before reading it, and a missing file", async () => {
    const big = new File([new Uint8Array(IMPORT_LIMITS.maxBytes + 1)], "big.csv");
    expect(await dryRunImportAction(form({ file: big }))).toEqual({ error: IMPORT_MESSAGES.tooLarge, field: "file" });
    expect(await commitImportAction(form({ file: big }))).toEqual({ error: IMPORT_MESSAGES.tooLarge, field: "file" });
    expect(await dryRunImportAction(form({}))).toEqual({ error: "Choose a CSV file first.", field: "file" });
  });

  it("turn an unreadable or oversized JSON field into a typed error, never a throw", async () => {
    const f = file(csv(["name", "Action Person"]));
    expect(await dryRunImportAction(form({ file: f, mapping: "{not json" }))).toMatchObject({ field: "mapping" });
    expect(await dryRunImportAction(form({ file: f, mapping: JSON.stringify({ pad: "x".repeat(100_001) }) }))).toMatchObject({ field: "mapping" });
    const checked = await dryRunImportAction(form({ file: f }));
    const sha = checked.report?.fileSha256 ?? "";
    const token = checked.report?.checkToken ?? "";
    expect(await commitImportAction(form({ file: f, sha, token, mapping: JSON.stringify(checked.report?.mapping), decisions: "[oops" }))).toMatchObject({
      field: "decisions",
    });
    expect(await commitImportAction(form({ file: f, sha, token, mapping: JSON.stringify(checked.report?.mapping), fingerprints: "x".repeat(100_001) }))).toMatchObject({
      field: "decisions",
    });
  });

  it("return the generic message when the service throws", async () => {
    session.mockResolvedValue({ ...A.as("owner"), tenantId: "not-a-uuid" });
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(await dryRunImportAction(form({ file: file(csv(["name", "Boom Person"])) }))).toEqual({ error: "Something went wrong. Please try again." });
    } finally {
      spy.mockRestore();
    }
  });

  it("run the whole flow for the owner and refuse other roles", async () => {
    const f = file(csv(["name,phone", "Flow Person,9000012345"]));
    const checked = await dryRunImportAction(form({ file: f }));
    expect(checked.report?.totals).toMatchObject({ new: 1 });
    const done = await commitImportAction(
      form({ file: f, sha: checked.report?.fileSha256 ?? "", token: checked.report?.checkToken ?? "", mapping: JSON.stringify(checked.report?.mapping), decisions: "{}", fingerprints: "{}" }),
    );
    expect(done.summary).toMatchObject({ created: 1 });
    session.mockResolvedValue(A.as("reception"));
    expect(await dryRunImportAction(form({ file: f }))).toMatchObject({ error: expect.stringContaining("owner") });
  });
});
