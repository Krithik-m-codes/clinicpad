import { DEFAULT_TIME_ZONE, isValidTimeZone } from "@/lib/rx-render/format";
import { withTenant, type TenantTx } from "@/server/db/tenant";
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
