import { and, asc, eq, ne } from "drizzle-orm";
import { fail, ok, type Result } from "@/lib/result";
import { can } from "@/lib/domain/permissions";
import { isUuid } from "@/lib/domain/ids";
import { prescriptionItems, prescriptions, visits } from "@/server/db/schema";
import { withTenant, type TenantTx } from "@/server/db/tenant";
import { parseRenderSnapshot, type RenderSnapshot } from "@/lib/rx-render/snapshot";
import type { ImageAsset, OverlayInput, RxDocument, RxStatus } from "@/lib/rx-render/types";
import type { ServiceContext } from "./context";
import { assetKey, loadImageAssets } from "./assets";
import { buildDraftSnapshot, buildRenderSnapshot } from "./render-snapshot";
import { unprintedContent } from "@/lib/rx-render/omitted";
import { loadOverlayIn, loadPinnedDefinitionIn, TEMPLATE_DAMAGED_MESSAGE } from "./template-resolution";
import { toItemView, toVisitView } from "./rx-mapping";

export type RxDocumentBundle = {
  prescriptionId: string;
  document: RxDocument;
  logo: ImageAsset | null;
  signature: ImageAsset | null;
  /** The frozen custom pad, loaded and hash-verified; null for built-in pads and when assets were not requested. */
  overlay: OverlayInput | null;
  /** Sections with content that the pinned overlay pad leaves off the paper (keys; empty for built-in pads). */
  unprintedSections: string[];
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
/** Who is looking at a document: it matters only for a draft (who may be named as its would-be signer). */
export type DocumentViewer = { userId: string | null; canFinalize: boolean };

export async function loadRxDocument(
  ctx: ServiceContext,
  id: string,
  opts: { withAssets?: boolean } = {},
): Promise<Result<RxDocumentBundle>> {
  if (!can(ctx.role, "rx.read")) return fail("forbidden", "You cannot view prescriptions.");
  if (!isUuid(id)) return notFound();

  return withTenant(ctx.tenantId, (tx) =>
    loadRxDocumentIn(tx, ctx.tenantId, id, { userId: ctx.userId, canFinalize: can(ctx.role, "rx.finalize") }, opts),
  );
}

/**
 * The body of loadRxDocument inside the caller's transaction (also used by the public share route, which has no
 * session: it passes a viewer with no user and only ever loads finalized or amended versions).
 */
export async function loadRxDocumentIn(
  tx: TenantTx,
  tenantId: string,
  id: string,
  viewer: DocumentViewer,
  opts: { withAssets?: boolean } = {},
): Promise<Result<RxDocumentBundle>> {
  const [row] = await tx
    .select({ rx: prescriptions, visit: visits })
    .from(prescriptions)
    .innerJoin(visits, eq(visits.id, prescriptions.visitId))
    .where(and(eq(prescriptions.tenantId, tenantId), eq(prescriptions.id, id)))
    .limit(1);
  if (!row) return notFound();
  const status = STATUSES.find((s) => s === row.rx.status);
  if (!status) return fail("invalid", "This prescription has an unknown status.");

  // Only a finalized or amended row has a frozen snapshot. A draft always renders from live data: whatever
  // a draft row holds in render_snapshot is never trusted (finalize overwrites it).
  let snapshot: RenderSnapshot;
  let snapshotSource: RxDocument["snapshotSource"];
  if (status !== "draft" && row.rx.renderSnapshot !== null && row.rx.renderSnapshot !== undefined) {
    const parsed = parseRenderSnapshot(row.rx.renderSnapshot);
    if (!parsed) return fail("invalid", "This prescription's print data is damaged and cannot be printed. Contact support.");
    snapshot = parsed;
    snapshotSource = "finalize";
  } else {
    const sources = {
      tenantId: tenantId,
      patientId: row.visit.patientId,
      // A pre-1C finalized row is signed by its finalizer. A draft is signed by nobody yet: its would-be signer is the
      // VIEWER, and only when the viewer can finalize (never the visit's doctor, whose name an amendment inherits).
      prescriberUserId: status === "draft" ? (viewer.canFinalize ? viewer.userId : null) : row.rx.finalizedBy,
      visitDoctorId: status === "draft" ? null : row.visit.doctorId,
      at: row.rx.finalizedAt ?? new Date(),
    };
    if (status === "draft") {
      // A draft previews on the pad its would-be signer would get (Plan 2A); a damaged pad fails closed here too.
      const built = await buildDraftSnapshot(tx, sources);
      if (!built.ok) return built;
      snapshot = built.value;
    } else {
      // Rows finalized before Plan 1C have no snapshot; they keep printing on the built-in pad.
      snapshot = await buildRenderSnapshot(tx, sources);
    }
    snapshotSource = "live";
    // A draft never embeds a signature image, whoever views it.
    if (status === "draft") snapshot = { ...snapshot, doctor: { ...snapshot.doctor, signatureAssetId: null } };
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

  const pinned = await loadPinnedDefinitionIn(tx, tenantId, snapshot.layout);
  const unprintedSections: string[] = pinned ? unprintedContent(document, pinned) : [];
  if (opts.withAssets === false) return ok({ prescriptionId: id, document, logo: null, signature: null, overlay: null, unprintedSections });
  const { logoAssetId } = snapshot.clinic;
  const { signatureAssetId } = snapshot.doctor;
  const assets = await loadImageAssets(tx, tenantId, [
    { id: logoAssetId, kind: "logo" },
    { id: signatureAssetId, kind: "signature" },
  ]);
  let overlay: OverlayInput | null = null;
  if (snapshot.layout.template.kind === "overlay") {
    // The column written at finalize must name the same version as the frozen snapshot (a draft has no column yet).
    if (status !== "draft" && row.rx.templateVersionId !== snapshot.layout.template.templateVersionId) {
      return fail("invalid", TEMPLATE_DAMAGED_MESSAGE);
    }
    overlay = await loadOverlayIn(tx, tenantId, snapshot.layout);
    if (!overlay) return fail("invalid", TEMPLATE_DAMAGED_MESSAGE);
  }
  return ok({
    prescriptionId: id,
    document,
    logo: logoAssetId ? (assets.get(assetKey("logo", logoAssetId)) ?? null) : null,
    signature: signatureAssetId ? (assets.get(assetKey("signature", signatureAssetId)) ?? null) : null,
    overlay,
    unprintedSections,
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
