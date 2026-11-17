import { auditEvents } from "@/server/db/schema";
import type { TenantTx } from "@/server/db/tenant";
import type { ServiceContext } from "./context";

export type AuditInput = {
  action: string;
  entityType: string;
  entityId?: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
};

/**
 * Appends an audit event inside the caller's transaction, so the event commits or rolls
 * back with the change it describes. Keep payloads to ids, counts and field names:
 * do not copy free-text patient data into the audit log.
 */
export async function recordAudit(
  tx: TenantTx,
  ctx: ServiceContext,
  event: AuditInput,
): Promise<void> {
  await tx.insert(auditEvents).values({
    tenantId: ctx.tenantId,
    actorUserId: ctx.userId,
    action: event.action,
    entityType: event.entityType,
    entityId: event.entityId,
    before: event.before,
    after: event.after,
  });
}

/** Several events in one statement, inside the caller's transaction (bulk import). Same payload rules as recordAudit. */
export async function recordAuditMany(tx: TenantTx, ctx: ServiceContext, events: readonly AuditInput[]): Promise<void> {
  if (events.length === 0) return;
  await tx.insert(auditEvents).values(
    events.map((event) => ({
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action: event.action,
      entityType: event.entityType,
      entityId: event.entityId,
      before: event.before,
      after: event.after,
    })),
  );
}
