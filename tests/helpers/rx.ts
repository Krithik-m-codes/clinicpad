import { eq } from "drizzle-orm";
import { isUuid } from "@/lib/domain/ids";
import { adminDb } from "@/server/db/admin";
import { prescriptions } from "@/server/db/schema";
import type { ServiceContext } from "@/server/services/context";
import { finalizePrescription, saveDraft } from "@/server/services/prescriptions";

/**
 * The service now requires the revision the caller saw (Plan 1C chore). Tests that are not about
 * revisions use these helpers, which read the stored revision first; a missing row or a malformed id
 * reports revision 0 so the service still answers not_found.
 */
export async function storedRevision(id: string): Promise<number> {
  if (!isUuid(id)) return 0;
  const [row] = await adminDb
    .select({ revision: prescriptions.draftRevision })
    .from(prescriptions)
    .where(eq(prescriptions.id, id))
    .limit(1);
  return row?.revision ?? 0;
}

/** saveDraft against whatever revision is stored right now. */
export async function saveDraftNow(ctx: ServiceContext, id: string, raw: unknown) {
  return saveDraft(ctx, id, raw, { baseRevision: await storedRevision(id) });
}

/** finalizePrescription for whatever revision is stored right now. */
export async function finalizeNow(ctx: ServiceContext, id: string) {
  return finalizePrescription(ctx, id, { expectedRevision: await storedRevision(id) });
}
