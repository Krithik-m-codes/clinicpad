import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

describe("database", () => {
  it("connects and answers select 1", async () => {
    const { db } = await import("@/server/db/client");
    const result = await db.execute(sql`select 1 as ok`);
    expect(Number(result[0]?.ok)).toBe(1);
  });
});
