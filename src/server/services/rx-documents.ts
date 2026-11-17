import { and, asc, eq, ne } from "drizzle-orm";
import { fail, ok, type Result } from "@/lib/result";
import { can } from "@/lib/domain/permissions";
import { isUuid } from "@/lib/domain/ids";
import { prescriptionItems, prescriptions, visits } from "@/server/db/schema";
import { withTenant, type TenantTx } from "@/server/db/tenant";
import { parseRenderSnapshot, type RenderSnapshot } from "@/lib/rx-render/snapshot";
import type { ImageAsset, RxDocument, RxStatus } from "@/lib/rx-render/types";
import type { ServiceContext } from "./context";
import { loadImageAssets } from "./assets";
import { buildRenderSnapshot } from "./render-snapshot";
import { toItemView, toVisitView } from "./rx-mapping";

export type RxDocumentBundle = {
  prescriptionId: string;
  document: RxDocument;
  logo: ImageAsset | null;
  signature: ImageAsset | null;
};

export type VersionRef = { id: string; version: number };

const STATUSES: readonly RxStatus[] = ["draft", "finalized", "amended"];
const notFound = () => fail("not_found", "Prescription not found.");

/** The finalized version that replaced this one (the child that is no longer a draft). */
async function supersedingVersion(tx: TenantTx, id: string) {
  const [row] = await tx
    .select({ id: prescriptions.id, version: prescriptions.version, finalizedAt: prescriptions.finalizedAt })
    .from(prescriptions)
    .where(and(eq(prescriptions.parentPrescriptionId, id), ne(prescriptions.status, "draft")))
    .orderBy(asc(prescriptions.version))
    .limit(1);
  return row ?? null;
}

/**
 * Everything needed to print one prescription. Finalized rows print from their frozen
 * snapshot; drafts and rows finalized before Plan 1C are built from live data and marked
 * "live". A snapshot that does not parse fails closed with `invalid`. A finalized row is
 * frozen, so its reads are consistent; a draft preview is not a record and may, for a moment,
 * mix a save that lands between the two reads (getPrescription's revision re-check is not
 * repeated here).
 */
export async function loadRxDocument(
  ctx: ServiceContext,
  id: string,
  opts: { withAssets?: boolean } = {},
): Promise<Result<RxDocumentBundle>> {
  if (!can(ctx.role, "rx.read")) return fail("forbidden", "You cannot view prescriptions.");
  if (!isUuid(id)) return notFound();

  return withTenant(ctx.tenantId, async (tx): Promise<Result<RxDocumentBundle>> => {
    const [row] = await tx
      .select({ rx: prescriptions, visit: visits })
      .from(prescriptions)
      .innerJoin(visits, eq(visits.id, prescriptions.visitId))
      .where(eq(prescriptions.id, id))
      .limit(1);
    if (!row) return notFound();
    const status = STATUSES.find((s) => s === row.rx.status);
    if (!status) return fail("invalid", "This prescription has an unknown status.");

    let snapshot: RenderSnapshot;
    let snapshotSource: RxDocument["snapshotSource"];
    if (row.rx.renderSnapshot !== null && row.rx.renderSnapshot !== undefined) {
      const parsed = parseRenderSnapshot(row.rx.renderSnapshot);
      if (!parsed) return fail("invalid", "This prescription's print data is damaged and cannot be printed. Contact support.");
      snapshot = parsed;
      snapshotSource = "finalize";
    } else {
      snapshot = await buildRenderSnapshot(tx, {
        patientId: row.visit.patientId,
        // A pre-1C finalized row is signed by its finalizer; only a draft falls back to the visit's doctor.
        prescriberUserId: row.rx.finalizedBy,
        visitDoctorId: row.visit.doctorId,
        at: row.rx.finalizedAt ?? new Date(),
      });
      snapshotSource = "live";
    }

    const items = await tx
      .select()
      .from(prescriptionItems)
      .where(eq(prescriptionItems.prescriptionId, id))
      .orderBy(asc(prescriptionItems.sortOrder));
    const superseding = status === "amended" ? await supersedingVersion(tx, id) : null;

    const document: RxDocument = {
      status,
      rxNo: row.rx.rxNo,
      version: row.rx.version,
      issuedAt: row.rx.finalizedAt ? row.rx.finalizedAt.toISOString() : null,
      supersededBy: superseding
        ? { version: superseding.version, issuedAt: superseding.finalizedAt ? superseding.finalizedAt.toISOString() : null }
        : null,
      replacesVersion: row.rx.parentPrescriptionId ? row.rx.version - 1 : null,
      snapshot,
      snapshotSource,
      visit: toVisitView(row.visit),
      items: items.map(toItemView),
    };

    if (opts.withAssets === false) return ok({ prescriptionId: id, document, logo: null, signature: null });
    const { logoAssetId } = snapshot.clinic;
    const { signatureAssetId } = snapshot.doctor;
    const assets = await loadImageAssets(tx, [logoAssetId, signatureAssetId]);
    return ok({
      prescriptionId: id,
      document,
      logo: logoAssetId ? (assets.get(logoAssetId) ?? null) : null,
      signature: signatureAssetId ? (assets.get(signatureAssetId) ?? null) : null,
    });
  });
}

/** Links between versions for the prescription page: the version that replaced this one, and the one it replaces. */
export async function getVersionLinks(
  ctx: ServiceContext,
  id: string,
): Promise<Result<{ supersededBy: VersionRef | null; replaces: VersionRef | null }>> {
  if (!can(ctx.role, "rx.read")) return fail("forbidden", "You cannot view prescriptions.");
  if (!isUuid(id)) return notFound();
  return withTenant(ctx.tenantId, async (tx) => {
    const [row] = await tx
      .select({ id: prescriptions.id, status: prescriptions.status, parentId: prescriptions.parentPrescriptionId })
      .from(prescriptions)
      .where(eq(prescriptions.id, id))
      .limit(1);
    if (!row) return notFound();
    const superseding = row.status === "amended" ? await supersedingVersion(tx, id) : null;
    let replaces: VersionRef | null = null;
    if (row.parentId) {
      const [parent] = await tx
        .select({ id: prescriptions.id, version: prescriptions.version })
        .from(prescriptions)
        .where(eq(prescriptions.id, row.parentId))
        .limit(1);
      replaces = parent ?? null;
    }
    return ok({ supersededBy: superseding ? { id: superseding.id, version: superseding.version } : null, replaces });
  });
}
