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
