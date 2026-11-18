import { sql } from "drizzle-orm";
import { db } from "./client";
import type { TenantTx } from "./tenant";

/**
 * The ONLY query path that runs without app.tenant_id (Plan 1D decision 7). It sets app.share_token_hash for this
 * transaction, which the policy share_link_by_token (0022) matches against share_links.token_hash: the caller can
 * read exactly the one link whose token it holds, and nothing else, in any table. Everything after the lookup
 * belongs in withTenant(link.tenantId).
 */
export async function withShareToken<T>(tokenHash: string, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
  if (!/^[0-9a-f]{64}$/.test(tokenHash)) throw new Error("tokenHash must be a SHA-256 hex digest");
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.share_token_hash', ${tokenHash}, true)`);
    return fn(tx);
  });
}
