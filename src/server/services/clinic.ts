import { eq } from "drizzle-orm";
import { can } from "@/lib/domain/permissions";
import { fail, ok, type Result } from "@/lib/result";
import { DEFAULT_TIME_ZONE, isValidTimeZone } from "@/lib/rx-render/format";
import { clinics } from "@/server/db/schema";
import { withTenant, type TenantTx } from "@/server/db/tenant";
import { recordAudit } from "./audit";
import type { ServiceContext } from "./context";
import { primaryClinic } from "./render-snapshot";

/** The clinic's IANA timezone, always valid: a missing or damaged value reads as Asia/Kolkata. */
export async function clinicTimeZoneIn(tx: TenantTx, tenantId: string): Promise<string> {
  const clinic = await primaryClinic(tx, tenantId);
  return clinic && isValidTimeZone(clinic.timezone) ? clinic.timezone : DEFAULT_TIME_ZONE;
}

/** Any member may know the clinic's timezone: it is configuration, not patient data. */
export async function getClinicTimeZone(ctx: ServiceContext): Promise<string> {
  return withTenant(ctx.tenantId, (tx) => clinicTimeZoneIn(tx, ctx.tenantId));
}

export async function getClinicSharing(ctx: ServiceContext): Promise<Result<{ enabled: boolean }>> {
  if (!can(ctx.role, "settings.clinic")) return fail("forbidden", "Only the clinic owner can change sharing.");
  return withTenant(ctx.tenantId, async (tx) => {
    const clinic = await primaryClinic(tx, ctx.tenantId);
    return clinic ? ok({ enabled: clinic.sharingEnabled }) : fail("not_found", "Clinic not found.");
  });
}

/** Turns sharing by link on or off for the clinic. Off makes every existing link answer "not found" at once. */
export async function setClinicSharing(ctx: ServiceContext, enabled: unknown): Promise<Result<{ enabled: boolean; changed: boolean }>> {
  if (!can(ctx.role, "settings.clinic")) return fail("forbidden", "Only the clinic owner can change sharing.");
  if (typeof enabled !== "boolean") return fail("invalid", "Choose whether sharing is on or off.", "sharingEnabled");
  return withTenant(ctx.tenantId, async (tx): Promise<Result<{ enabled: boolean; changed: boolean }>> => {
    const clinic = await primaryClinic(tx, ctx.tenantId, true);
    if (!clinic) return fail("not_found", "Clinic not found.");
    if (clinic.sharingEnabled === enabled) return ok({ enabled, changed: false });
    await tx.update(clinics).set({ sharingEnabled: enabled }).where(eq(clinics.id, clinic.id));
    await recordAudit(tx, ctx, { action: "clinic.sharing_changed", entityType: "clinic", entityId: clinic.id, after: { enabled } });
    return ok({ enabled, changed: true });
  });
}
