import { sql } from "drizzle-orm";
import { tenantCounters } from "@/server/db/schema";
import type { TenantTx } from "@/server/db/tenant";

export type SequenceName = "patient" | "rx";

/**
 * Next per-tenant number. The upsert takes a row lock, so concurrent callers queue and
 * each gets a distinct number; a rolled-back transaction releases its number.
 */
export async function allocateNumber(
  tx: TenantTx,
  tenantId: string,
  name: SequenceName,
): Promise<number> {
  const [row] = await tx
    .insert(tenantCounters)
    .values({ tenantId, name, lastNo: 1 })
    .onConflictDoUpdate({
      target: [tenantCounters.tenantId, tenantCounters.name],
      set: { lastNo: sql`${tenantCounters.lastNo} + 1` },
    })
    .returning({ value: tenantCounters.lastNo });
  return row.value;
}

/**
 * The first number of a block of `count` consecutive numbers, reserved in one upsert (bulk import). Same locking and
 * rollback behaviour as allocateNumber: concurrent callers queue on the counter row; a rolled-back block is released.
 */
export async function allocateNumbers(tx: TenantTx, tenantId: string, name: SequenceName, count: number): Promise<number> {
  if (!Number.isSafeInteger(count) || count < 1) throw new Error("count must be a positive whole number");
  const [row] = await tx
    .insert(tenantCounters)
    .values({ tenantId, name, lastNo: count })
    .onConflictDoUpdate({
      target: [tenantCounters.tenantId, tenantCounters.name],
      set: { lastNo: sql`${tenantCounters.lastNo} + ${count}` },
    })
    .returning({ value: tenantCounters.lastNo });
  return row.value - count + 1;
}
