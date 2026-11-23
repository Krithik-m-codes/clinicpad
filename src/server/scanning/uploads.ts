import { fail, ok, type Result } from "@/lib/result";
import { withTenant } from "@/server/db/tenant";
import { recordAudit } from "@/server/services/audit";
import type { ServiceContext } from "@/server/services/context";
import { getMalwareScanner } from "./index";
import { SCAN_MESSAGES, type MalwareScanner } from "./scanner";

export type ScanAudit = { action: string; entityType: string; kind: string; field: string };

/**
 * Scans uploaded bytes BEFORE any transaction opens (a scan can take seconds). Infected: refused and audited with the
 * signature name (not personal data). Scanner unavailable: refused, logged with a short reason, not audited (not the
 * user's doing). Nothing is ever stored unscanned, so there is no quarantine state.
 */
export async function scanOrRefuse(
  ctx: ServiceContext,
  bytes: Uint8Array,
  audit: ScanAudit,
  scanner: MalwareScanner = getMalwareScanner(),
  signal?: AbortSignal,
): Promise<Result<{ engine: string }>> {
  const outcome = await scanner.scan(bytes, { signal });
  if (outcome.status === "clean") return ok({ engine: outcome.engine });
  if (outcome.status === "infected") {
    await withTenant(ctx.tenantId, (tx) =>
      recordAudit(tx, ctx, {
        action: audit.action,
        entityType: audit.entityType,
        after: { kind: audit.kind, reasonCode: "infected", signature: outcome.signature, byteSize: bytes.length, scanEngine: outcome.engine },
      }),
    );
    return fail("invalid", SCAN_MESSAGES.infected, audit.field);
  }
  console.warn(`[scan] upload refused: scanner unavailable (${outcome.reason.slice(0, 80)})`);
  return fail("unavailable", SCAN_MESSAGES.unavailable, audit.field);
}
