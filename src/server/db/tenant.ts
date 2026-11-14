import { sql } from "drizzle-orm";
import { db } from "./client";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function withTenant<T>(
  tenantId: string,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  if (!tenantId) throw new Error("tenantId is required");
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
    return fn(tx);
  });
}
