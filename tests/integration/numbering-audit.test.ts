import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { withTenant } from "@/server/db/tenant";
import { pgErrorInfo } from "@/server/db/errors";
import { auditEvents } from "@/server/db/schema";
import { allocateNumber } from "@/server/services/numbering";
import { recordAudit } from "@/server/services/audit";
import { isUuid, newId } from "@/lib/domain/ids";
import { createTestTenant, type TestTenant } from "../helpers/tenant";

let A: TestTenant;
let B: TestTenant;

beforeAll(async () => {
  A = await createTestTenant("numa");
  B = await createTestTenant("numb");
});
afterAll(async () => {
  await A.cleanup();
  await B.cleanup();
});

describe("allocateNumber", () => {
  it("counts per tenant and per sequence name", async () => {
    const a1 = await withTenant(A.tenantId, (tx) => allocateNumber(tx, A.tenantId, "patient"));
    const a2 = await withTenant(A.tenantId, (tx) => allocateNumber(tx, A.tenantId, "patient"));
    const aRx = await withTenant(A.tenantId, (tx) => allocateNumber(tx, A.tenantId, "rx"));
    const b1 = await withTenant(B.tenantId, (tx) => allocateNumber(tx, B.tenantId, "patient"));
    expect([a1, a2, aRx, b1]).toEqual([1, 2, 1, 1]);
  });

  it("hands out unique consecutive numbers under concurrency", async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, () => withTenant(A.tenantId, (tx) => allocateNumber(tx, A.tenantId, "rx"))),
    );
    const sorted = [...results].sort((x, y) => x - y);
    // "rx" was already at 1 from the previous test.
    expect(sorted).toEqual(Array.from({ length: 10 }, (_, i) => i + 2));
  });

  it("does not burn a number when the transaction rolls back", async () => {
    const before = await withTenant(B.tenantId, (tx) => allocateNumber(tx, B.tenantId, "rx"));
    await expect(
      withTenant(B.tenantId, async (tx) => {
        await allocateNumber(tx, B.tenantId, "rx");
        throw new Error("abort");
      }),
    ).rejects.toThrow("abort");
    const after = await withTenant(B.tenantId, (tx) => allocateNumber(tx, B.tenantId, "rx"));
    expect(after).toBe(before + 1);
  });
});

describe("recordAudit", () => {
  it("writes an event attributed to the actor and tenant", async () => {
    const ctx = A.as("owner");
    const entityId = newId();
    await withTenant(A.tenantId, (tx) =>
      recordAudit(tx, ctx, {
        action: "test.happened",
        entityType: "test",
        entityId,
        after: { n: 1 },
      }),
    );
    const rows = await withTenant(A.tenantId, (tx) =>
      tx.select().from(auditEvents).where(eq(auditEvents.entityId, entityId)),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tenantId: A.tenantId, actorUserId: ctx.userId, action: "test.happened" });
  });

  it("is append-only for the application role", async () => {
    const update = withTenant(A.tenantId, (tx) => tx.update(auditEvents).set({ action: "tampered" }));
    await expect(update).rejects.toSatisfy((e: unknown) => pgErrorInfo(e).code === "42501");
    const del = withTenant(A.tenantId, (tx) => tx.delete(auditEvents));
    await expect(del).rejects.toSatisfy((e: unknown) => pgErrorInfo(e).code === "42501");
  });
});

describe("isUuid", () => {
  it("accepts UUIDv7 and rejects junk", () => {
    expect(isUuid(newId())).toBe(true);
    expect(isUuid("abc")).toBe(false);
    expect(isUuid("")).toBe(false);
    expect(isUuid("1; drop table patients")).toBe(false);
  });
});
