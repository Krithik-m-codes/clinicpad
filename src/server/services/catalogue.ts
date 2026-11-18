import { and, asc, count, eq, ilike, or, sql } from "drizzle-orm";
import { fail, invalidFrom, ok, type Result } from "@/lib/result";
import { can } from "@/lib/domain/permissions";
import { isUuid } from "@/lib/domain/ids";
import { RX_LIMITS, TERM_KINDS, type TermKind } from "@/lib/domain/rx-options";
import { catalogueKey, clampLimit, escapeLike, searchTerm } from "@/lib/domain/search";
import { doctors, globalClinicalTerms, globalMedicines, medicineFavourites, tenantMedicines } from "@/server/db/schema";
import { withTenant, type TenantTx } from "@/server/db/tenant";
import { clinicMedicineInputSchema } from "@/server/validation/catalogue";
import { prescriptionItemSchema } from "@/server/validation/prescription";
import type { ServiceContext } from "./context";
import { recordAudit } from "./audit";

export type FavouriteView = {
  id: string;
  drugName: string;
  genericName: string | null;
  strength: string | null;
  form: string | null;
  route: string | null;
  dose: string | null;
  doseMorning: number | null;
  doseAfternoon: number | null;
  doseEvening: number | null;
  doseNight: number | null;
  timing: string | null;
  foodRelation: string | null;
  periodicity: string | null;
  isSos: boolean;
  durationValue: number | null;
  durationUnit: string | null;
  remarks: string | null;
};

export type MedicineHit = {
  source: "favourite" | "clinic" | "global";
  id: string;
  name: string;
  genericName: string | null;
  favourite: FavouriteView | null;
};

type FavouriteRow = typeof medicineFavourites.$inferSelect;

const SOURCE_RANK: Record<MedicineHit["source"], number> = { favourite: 0, clinic: 1, global: 2 };

function toFavouriteView(row: FavouriteRow): FavouriteView {
  return {
    id: row.id,
    drugName: row.drugName,
    genericName: row.genericName,
    strength: row.strength,
    form: row.form,
    route: row.route,
    dose: row.dose,
    doseMorning: row.doseMorning,
    doseAfternoon: row.doseAfternoon,
    doseEvening: row.doseEvening,
    doseNight: row.doseNight,
    timing: row.timing,
    foodRelation: row.foodRelation,
    periodicity: row.periodicity,
    isSos: row.isSos,
    durationValue: row.durationValue,
    durationUnit: row.durationUnit,
    remarks: row.remarks,
  };
}

const favouriteNotFound = () => fail("not_found", "Favourite not found.");
const NO_DOCTOR_PROFILE = "Favourites belong to a doctor profile, and this account has none in this clinic.";

/**
 * The caller's doctor profile in this clinic, or null. doctors_tenant_user_uq (migration 0010) makes it
 * unique, and RLS limits the lookup to the session's tenant.
 */
async function callerDoctorId(tx: TenantTx, userId: string): Promise<string | null> {
  const [doctor] = await tx.select({ id: doctors.id }).from(doctors).where(eq(doctors.userId, userId)).limit(1);
  return doctor?.id ?? null;
}

async function favouritesOf(tx: TenantTx, doctorId: string | null): Promise<FavouriteView[]> {
  if (doctorId === null) return [];
  const rows = await tx
    .select()
    .from(medicineFavourites)
    .where(eq(medicineFavourites.doctorId, doctorId))
    .orderBy(asc(medicineFavourites.drugName), asc(medicineFavourites.id))
    .limit(RX_LIMITS.favouritesPerDoctor);
  return rows.map(toFavouriteView);
}

/**
 * Total order for search results: favourites, then prefix matches, then favourite/clinic/global,
 * then name, then id, so two calls never disagree about the order of equal-looking rows.
 */
export function compareMedicineHits(a: MedicineHit, b: MedicineHit, lowerTerm: string): number {
  const isPrefix = (hit: MedicineHit) => hit.name.toLowerCase().startsWith(lowerTerm);
  return (
    Number(b.favourite !== null) - Number(a.favourite !== null) ||
    Number(isPrefix(b)) - Number(isPrefix(a)) ||
    SOURCE_RANK[a.source] - SOURCE_RANK[b.source] ||
    a.name.localeCompare(b.name) ||
    a.id.localeCompare(b.id)
  );
}

/** Options arrive from the client untyped, so tolerate null, strings and other non-objects. */
function optionsOf(opts: unknown): { q?: unknown; limit?: unknown; kind?: unknown } {
  return typeof opts === "object" && opts !== null ? opts : {};
}

export async function searchMedicines(
  ctx: ServiceContext,
  rawOpts: { q?: unknown; limit?: unknown } = {},
): Promise<Result<MedicineHit[]>> {
  if (!can(ctx.role, "catalogue.read")) return fail("forbidden", "You cannot search the medicine list.");
  const opts = optionsOf(rawOpts);
  const term = searchTerm(opts.q, RX_LIMITS.searchQuery);
  const limit = clampLimit(opts.limit, 20, 50);
  const lower = term.toLowerCase();

  return withTenant(ctx.tenantId, async (tx) => {
    // Nurses and pharmacists may search too; they normally have no doctor profile, so no favourites.
    const favourites = await favouritesOf(tx, await callerDoctorId(tx, ctx.userId));

    // Favourites are filtered in memory (at most 200 rows), so wildcards cannot apply here either.
    const favouriteHits: MedicineHit[] = favourites
      .filter(
        (f) =>
          lower === "" ||
          f.drugName.toLowerCase().includes(lower) ||
          (f.genericName ?? "").toLowerCase().includes(lower),
      )
      .map((f) => ({ source: "favourite", id: f.id, name: f.drugName, genericName: f.genericName, favourite: f }));
    if (term === "") return ok(favouriteHits.slice(0, limit));

    const pattern = `%${escapeLike(term)}%`;
    const prefix = `${escapeLike(term)}%`;
    const clinicRows = await tx
      .select({ id: tenantMedicines.id, name: tenantMedicines.name, genericName: tenantMedicines.genericName })
      .from(tenantMedicines)
      .where(or(ilike(tenantMedicines.name, pattern), ilike(tenantMedicines.genericName, pattern)))
      .orderBy(sql`case when ${tenantMedicines.name} ilike ${prefix} then 0 else 1 end`, asc(tenantMedicines.name), asc(tenantMedicines.id))
      .limit(limit);
    const globalRows = await tx
      .select({ id: globalMedicines.id, name: globalMedicines.name, genericName: globalMedicines.genericName })
      .from(globalMedicines)
      .where(or(ilike(globalMedicines.name, pattern), ilike(globalMedicines.genericName, pattern)))
      .orderBy(sql`case when ${globalMedicines.name} ilike ${prefix} then 0 else 1 end`, asc(globalMedicines.name), asc(globalMedicines.id))
      .limit(limit);

    // First occurrence of a name wins: favourite, then clinic, then global.
    const hits: MedicineHit[] = [];
    const seen = new Set<string>();
    const add = (hit: MedicineHit) => {
      const k = catalogueKey(hit.name);
      if (seen.has(k)) return;
      seen.add(k);
      hits.push(hit);
    };
    favouriteHits.forEach(add);
    clinicRows.forEach((r) => add({ source: "clinic", ...r, favourite: null }));
    globalRows.forEach((r) => add({ source: "global", ...r, favourite: null }));

    hits.sort((a, b) => compareMedicineHits(a, b, lower));
    return ok(hits.slice(0, limit));
  });
}

export async function addClinicMedicine(
  ctx: ServiceContext,
  raw: unknown,
): Promise<Result<{ id: string; created: boolean }>> {
  if (!can(ctx.role, "catalogue.write")) return fail("forbidden", "Only doctors can add medicines to the clinic list.");
  const parsed = clinicMedicineInputSchema.safeParse(raw);
  if (!parsed.success) return invalidFrom(parsed.error);
  const { name, genericName } = parsed.data;
  const nameKey = catalogueKey(name);

  return withTenant(ctx.tenantId, async (tx) => {
    const inserted = await tx
      .insert(tenantMedicines)
      .values({ tenantId: ctx.tenantId, name, genericName: genericName ?? null, nameKey, createdBy: ctx.userId })
      .onConflictDoNothing({ target: [tenantMedicines.tenantId, tenantMedicines.nameKey] })
      .returning({ id: tenantMedicines.id });
    if (inserted.length > 0) {
      await recordAudit(tx, ctx, { action: "medicine.added", entityType: "tenant_medicine", entityId: inserted[0].id });
      return ok({ id: inserted[0].id, created: true });
    }
    const [existing] = await tx
      .select({ id: tenantMedicines.id })
      .from(tenantMedicines)
      .where(eq(tenantMedicines.nameKey, nameKey))
      .limit(1);
    // Only reachable if the row was deleted between the insert and this read.
    if (!existing) return fail("conflict", "Could not add the medicine. Please try again.");
    return ok({ id: existing.id, created: false });
  });
}

export async function listFavourites(ctx: ServiceContext): Promise<Result<FavouriteView[]>> {
  if (!can(ctx.role, "rx.draft")) return fail("forbidden", "Only prescribers keep favourites.");
  const favourites = await withTenant(ctx.tenantId, async (tx) => favouritesOf(tx, await callerDoctorId(tx, ctx.userId)));
  return ok(favourites);
}

/** Saves the caller's default line for a medicine; saving the same medicine again updates it. */
export async function saveFavourite(ctx: ServiceContext, raw: unknown): Promise<Result<FavouriteView>> {
  if (!can(ctx.role, "rx.draft")) return fail("forbidden", "Only prescribers keep favourites.");
  const parsed = prescriptionItemSchema.safeParse(raw);
  if (!parsed.success) return invalidFrom(parsed.error);
  const item = parsed.data;
  const nameKey = catalogueKey(item.drugName);
  const columns = {
    drugName: item.drugName,
    genericName: item.genericName ?? null,
    strength: item.strength ?? null,
    form: item.form ?? null,
    route: item.route ?? null,
    dose: item.dose ?? null,
    doseMorning: item.doseMorning,
    doseAfternoon: item.doseAfternoon,
    doseEvening: item.doseEvening,
    doseNight: item.doseNight,
    timing: item.timing ?? null,
    foodRelation: item.foodRelation ?? null,
    periodicity: item.periodicity ?? null,
    isSos: item.isSos,
    durationValue: item.durationValue,
    durationUnit: item.durationUnit,
    remarks: item.remarks ?? null,
  };

  return withTenant(ctx.tenantId, async (tx): Promise<Result<FavouriteView>> => {
    const doctorId = await callerDoctorId(tx, ctx.userId);
    if (doctorId === null) return fail("invalid", NO_DOCTOR_PROFILE, "favourites");
    // Saves for one doctor take turns, so the count below cannot go stale between two concurrent saves.
    await tx.select({ id: doctors.id }).from(doctors).where(eq(doctors.id, doctorId)).for("no key update");
    const [existing] = await tx
      .select({ id: medicineFavourites.id })
      .from(medicineFavourites)
      .where(and(eq(medicineFavourites.doctorId, doctorId), eq(medicineFavourites.nameKey, nameKey)))
      .limit(1);
    if (!existing) {
      const [{ value: total }] = await tx
        .select({ value: count() })
        .from(medicineFavourites)
        .where(eq(medicineFavourites.doctorId, doctorId));
      if (total >= RX_LIMITS.favouritesPerDoctor) {
        return fail(
          "invalid",
          `You can keep up to ${RX_LIMITS.favouritesPerDoctor} favourites. Remove one first.`,
          "favourites",
        );
      }
    }
    const [row] = await tx
      .insert(medicineFavourites)
      .values({ tenantId: ctx.tenantId, doctorId, nameKey, ...columns })
      .onConflictDoUpdate({
        target: [medicineFavourites.tenantId, medicineFavourites.doctorId, medicineFavourites.nameKey],
        set: { ...columns, updatedAt: new Date() },
      })
      .returning();
    return ok(toFavouriteView(row));
  });
}

export async function removeFavourite(ctx: ServiceContext, id: string): Promise<Result<null>> {
  if (!can(ctx.role, "rx.draft")) return fail("forbidden", "Only prescribers keep favourites.");
  if (!isUuid(id)) return favouriteNotFound();
  return withTenant(ctx.tenantId, async (tx): Promise<Result<null>> => {
    const doctorId = await callerDoctorId(tx, ctx.userId);
    if (doctorId === null) return favouriteNotFound();
    const removed = await tx
      .delete(medicineFavourites)
      .where(and(eq(medicineFavourites.id, id), eq(medicineFavourites.doctorId, doctorId)))
      .returning({ id: medicineFavourites.id });
    return removed.length > 0 ? ok(null) : favouriteNotFound();
  });
}

export async function suggestTerms(
  ctx: ServiceContext,
  rawOpts: { kind: unknown; q?: unknown; limit?: unknown },
): Promise<Result<string[]>> {
  if (!can(ctx.role, "catalogue.read")) return fail("forbidden", "You cannot search clinical lists.");
  const opts = optionsOf(rawOpts);
  if (typeof opts.kind !== "string" || !(TERM_KINDS as readonly string[]).includes(opts.kind)) {
    return fail("invalid", "Unknown suggestion list.", "kind");
  }
  const kind = opts.kind as TermKind;
  const term = searchTerm(opts.q, RX_LIMITS.searchQuery);
  if (term === "") return ok([]);
  const limit = clampLimit(opts.limit, 15, 50);
  const pattern = `%${escapeLike(term)}%`;
  const prefix = `${escapeLike(term)}%`;

  const rows = await withTenant(ctx.tenantId, (tx) =>
    tx
      .select({ name: globalClinicalTerms.name })
      .from(globalClinicalTerms)
      .where(and(eq(globalClinicalTerms.kind, kind), ilike(globalClinicalTerms.name, pattern)))
      .orderBy(sql`case when ${globalClinicalTerms.name} ilike ${prefix} then 0 else 1 end`, asc(globalClinicalTerms.name), asc(globalClinicalTerms.id))
      .limit(limit),
  );
  return ok(rows.map((r) => r.name));
}
