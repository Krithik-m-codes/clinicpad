import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { can } from "@/lib/domain/permissions";
import { isUuid } from "@/lib/domain/ids";
import { CONSENT_METHODS, isConsentVersion, type ConsentMethod, type ConsentVersion } from "@/lib/domain/consent";
import { fail, invalidFrom, ok, type Result } from "@/lib/result";
import { patientConsents, patients } from "@/server/db/schema";
import { withTenant, type TenantTx } from "@/server/db/tenant";
import { recordAudit } from "./audit";
import type { ServiceContext } from "./context";
import { revokeActiveLinksForPatient } from "./share-revocation";

export type ConsentView = { id: string; granted: boolean; version: string; method: ConsentMethod; recordedAt: Date };

const PURPOSE = "sharing";
const notFound = () => fail("not_found", "Patient not found.");
const method = z.enum(CONSENT_METHODS, { error: "Choose how the patient gave consent." });
const recordSchema = z.object({
  method,
  confirmed: z.literal(true, { error: "Confirm that the patient agreed to the text above." }),
  // The version of the text the card showed; an unknown one is refused, a known one is recorded as shown.
  version: z.custom<ConsentVersion>(isConsentVersion, { error: "This consent text is out of date. Reload the page and try again." }),
});
const withdrawSchema = z.object({ method: z.enum(CONSENT_METHODS, { error: "Choose how the patient withdrew consent." }) });

function view(row: typeof patientConsents.$inferSelect): ConsentView {
  return { id: row.id, granted: row.granted, version: row.version, method: row.method as ConsentMethod, recordedAt: row.createdAt };
}

/** The latest sharing-consent event of a patient, or null. */
export async function currentSharingConsentIn(tx: TenantTx, tenantId: string, patientId: string): Promise<ConsentView | null> {
  const [row] = await tx
    .select()
    .from(patientConsents)
    .where(and(eq(patientConsents.tenantId, tenantId), eq(patientConsents.patientId, patientId), eq(patientConsents.purpose, PURPOSE)))
    .orderBy(desc(patientConsents.createdAt), desc(patientConsents.id))
    .limit(1);
  return row ? view(row) : null;
}

export async function getSharingConsent(ctx: ServiceContext, patientId: string): Promise<Result<ConsentView | null>> {
  if (!can(ctx.role, "patient.read")) return fail("forbidden", "You cannot view patients.");
  if (!isUuid(patientId)) return notFound();
  return withTenant(ctx.tenantId, async (tx) => ok(await currentSharingConsentIn(tx, ctx.tenantId, patientId)));
}

/**
 * Records that the patient agreed to the consent text version the caller names (it must be a known version), how, and by whom. The
 * patient row is locked first (decision 13). Recording again while the same version is granted writes nothing.
 */
export async function recordSharingConsent(ctx: ServiceContext, patientId: string, raw: unknown): Promise<Result<ConsentView>> {
  if (!can(ctx.role, "consent.capture")) return fail("forbidden", "You cannot record consent.");
  if (!isUuid(patientId)) return notFound();
  const parsed = recordSchema.safeParse(raw);
  if (!parsed.success) return invalidFrom(parsed.error);
  return withTenant(ctx.tenantId, async (tx): Promise<Result<ConsentView>> => {
    const [patient] = await tx
      .select({ id: patients.id })
      .from(patients)
      .where(and(eq(patients.tenantId, ctx.tenantId), eq(patients.id, patientId), isNull(patients.deletedAt)))
      .limit(1)
      .for("update");
    if (!patient) return notFound();
    const current = await currentSharingConsentIn(tx, ctx.tenantId, patientId);
    if (current?.granted && current.version === parsed.data.version) return ok(current);
    const [row] = await tx
      .insert(patientConsents)
      .values({ tenantId: ctx.tenantId, patientId, purpose: PURPOSE, version: parsed.data.version, granted: true, method: parsed.data.method, capturedBy: ctx.userId })
      .returning();
    await recordAudit(tx, ctx, {
      action: "patient.consent_recorded",
      entityType: "patient",
      entityId: patientId,
      after: { consentId: row.id, purpose: PURPOSE, version: parsed.data.version, method: parsed.data.method },
    });
    return ok(view(row));
  });
}

/**
 * Records a withdrawal and revokes every open share link of the patient in the same transaction (DPDP: stop
 * processing). Allowed for archived patients too: withdrawing must always be possible.
 */
export async function withdrawSharingConsent(ctx: ServiceContext, patientId: string, raw: unknown): Promise<Result<{ revokedLinks: number }>> {
  if (!can(ctx.role, "consent.capture")) return fail("forbidden", "You cannot record consent.");
  if (!isUuid(patientId)) return notFound();
  const parsed = withdrawSchema.safeParse(raw);
  if (!parsed.success) return invalidFrom(parsed.error);
  return withTenant(ctx.tenantId, async (tx): Promise<Result<{ revokedLinks: number }>> => {
    const [patient] = await tx
      .select({ id: patients.id })
      .from(patients)
      .where(and(eq(patients.tenantId, ctx.tenantId), eq(patients.id, patientId)))
      .limit(1)
      .for("update");
    if (!patient) return notFound();
    const current = await currentSharingConsentIn(tx, ctx.tenantId, patientId);
    if (!current?.granted) return fail("conflict", "No sharing consent is on record for this patient.");
    const [row] = await tx
      .insert(patientConsents)
      .values({ tenantId: ctx.tenantId, patientId, purpose: PURPOSE, version: current.version, granted: false, method: parsed.data.method, capturedBy: ctx.userId })
      .returning({ id: patientConsents.id });
    const revokedLinks = await revokeActiveLinksForPatient(tx, ctx.tenantId, patientId, "consent_withdrawn", ctx.userId);
    await recordAudit(tx, ctx, {
      action: "patient.consent_withdrawn",
      entityType: "patient",
      entityId: patientId,
      after: { consentId: row.id, purpose: PURPOSE, version: current.version, method: parsed.data.method, revokedLinks },
    });
    return ok({ revokedLinks });
  });
}
