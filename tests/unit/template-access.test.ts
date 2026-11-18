import { describe, expect, it } from "vitest";
import { FILE_GONE_MESSAGE, mayWriteTemplate, withFileFkMapped, type VersionRow } from "@/server/services/template-access";

const pgError = (code: string, constraint: string) => Object.assign(new Error("boom"), { code, constraint_name: constraint });
const version = (identity: "dynamic" | "bound", boundDoctorId: string | null) => ({ identity, boundDoctorId }) as VersionRow;

describe("withFileFkMapped", () => {
  it("turns a collected file (23503 on template_versions_file_fk) into a friendly not_found", async () => {
    const result = await withFileFkMapped(async () => {
      throw pgError("23503", "template_versions_file_fk");
    });
    expect(result).toEqual({ ok: false, code: "not_found", message: FILE_GONE_MESSAGE, field: "fileId" });
  });

  it("rethrows every other error and passes results through", async () => {
    await expect(withFileFkMapped(async () => Promise.reject(pgError("23503", "template_versions_template_fk")))).rejects.toThrow("boom");
    await expect(withFileFkMapped(async () => Promise.reject(new Error("other")))).rejects.toThrow("other");
    expect(await withFileFkMapped(async () => 7)).toBe(7);
  });
});

describe("mayWriteTemplate", () => {
  const ctx = (role: string) => ({ tenantId: "t", userId: "u", role });
  it("lets a doctor write only a template whose working binding is their own profile", () => {
    expect(mayWriteTemplate(ctx("doctor"), { draft: version("bound", "d1"), current: null }, "d1")).toBe(true);
    expect(mayWriteTemplate(ctx("doctor"), { draft: version("bound", "d1"), current: null }, "d2")).toBe(false);
    expect(mayWriteTemplate(ctx("doctor"), { draft: version("dynamic", null), current: version("bound", "d1") }, "d1")).toBe(false);
    expect(mayWriteTemplate(ctx("doctor"), { draft: null, current: version("bound", "d1") }, null)).toBe(false);
    expect(mayWriteTemplate(ctx("doctor"), { draft: null, current: null }, "d1")).toBe(false);
  });
  it("lets owners and designers write any template and nobody else", () => {
    for (const role of ["owner", "designer"]) expect(mayWriteTemplate(ctx(role), { draft: version("dynamic", null), current: null }, null)).toBe(true);
    for (const role of ["reception", "nurse", "pharmacist", "accountant"]) expect(mayWriteTemplate(ctx(role), { draft: version("dynamic", null), current: null }, null)).toBe(false);
  });
});
