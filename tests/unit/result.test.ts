import { describe, expect, it } from "vitest";
import { z } from "zod";
import { fail, invalidFrom } from "@/lib/result";

describe("invalidFrom", () => {
  const schema = z.object({ items: z.array(z.object({ dose: z.string().max(3) })), name: z.string().min(2) });

  it("keeps field as the first path segment and adds the full dotted path for nested problems", () => {
    const parsed = schema.safeParse({ items: [{ dose: "ok" }, { dose: "ok" }, { dose: "too long" }], name: "ab" });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(invalidFrom(parsed.error)).toMatchObject({ ok: false, code: "invalid", field: "items", path: "items.2.dose" });
  });

  it("leaves path off when the problem is at the top level", () => {
    const parsed = schema.safeParse({ items: [], name: "a" });
    if (parsed.success) throw new Error("expected a failure");
    const error = invalidFrom(parsed.error);
    expect(error.field).toBe("name");
    expect("path" in error).toBe(false);
  });

  it("fail() is unchanged", () => {
    expect(fail("invalid", "m", "f")).toEqual({ ok: false, code: "invalid", message: "m", field: "f" });
  });
});
