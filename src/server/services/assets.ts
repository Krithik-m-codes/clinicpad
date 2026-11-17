import { createHash } from "node:crypto";
import { and, count, eq, inArray } from "drizzle-orm";
import { clinicAssets } from "@/server/db/schema";
import type { TenantTx } from "@/server/db/tenant";
import type { ImageAsset } from "@/lib/rx-render/types";
import { inspectImage, stripImageMetadata, type ImageMime } from "@/lib/domain/image";
import { fail, ok, type Result } from "@/lib/result";
import type { ServiceContext } from "./context";

export type AssetPreview = { id: string; dataUrl: string; width: number; height: number };
export type AssetKind = "logo" | "signature";

/** Most distinct images a clinic may keep per kind (assets are never deleted, so this bounds storage). */
export const ASSET_CAPS: Record<AssetKind, number> = { logo: 20, signature: 50 };

function asMime(value: string): ImageAsset["mime"] | null {
  return value === "image/png" || value === "image/jpeg" ? value : null;
}

export type AssetRequest = { id: string | null; kind: AssetKind };

/** Key of an entry in the map loadImageAssets returns. The kind is part of it: one id is never both a logo and a signature. */
export function assetKey(kind: AssetKind, id: string): string {
  return `${kind}:${id}`;
}

/**
 * Loads images by id. The caller says what each image must be (a logo is never served as a signature)
 * and which tenant it belongs to; both filters apply on top of row-level security, so another clinic's
 * ids, or an id of the wrong kind, are simply not found. The result is keyed by assetKey(kind, id), so a
 * request for the same id as both kinds can never be answered with the wrong one.
 */
export async function loadImageAssets(
  tx: TenantTx,
  tenantId: string,
  requests: AssetRequest[],
): Promise<Map<string, ImageAsset>> {
  const found = new Map<string, ImageAsset>();
  for (const kind of ["logo", "signature"] as const) {
    const wanted = [...new Set(requests.filter((r) => r.kind === kind && r.id !== null).map((r) => r.id as string))];
    if (wanted.length === 0) continue;
    const rows = await tx
      .select({ id: clinicAssets.id, mime: clinicAssets.mime, width: clinicAssets.width, height: clinicAssets.height, bytes: clinicAssets.bytes })
      .from(clinicAssets)
      .where(and(eq(clinicAssets.tenantId, tenantId), eq(clinicAssets.kind, kind), inArray(clinicAssets.id, wanted)));
    for (const row of rows) {
      const mime = asMime(row.mime);
      if (mime) found.set(assetKey(kind, row.id), { mime, width: row.width, height: row.height, base64: row.bytes.toString("base64") });
    }
  }
  return found;
}

export function assetPreview(id: string, asset: ImageAsset): AssetPreview {
  return { id, dataUrl: `data:${asset.mime};base64,${asset.base64}`, width: asset.width, height: asset.height };
}

export type StoredAsset = { id: string; mime: ImageMime; width: number; height: number; byteSize: number };

/**
 * Validates an uploaded image from its bytes (never from a file name or declared type, which are not kept)
 * and stores it once per clinic and kind: identical bytes reuse the existing row. Assets are never updated
 * or deleted afterwards. Metadata is stripped first; the hash is computed here, from the bytes that are stored.
 */
export async function storeImageAsset(
  tx: TenantTx,
  ctx: ServiceContext,
  kind: AssetKind,
  uploaded: Uint8Array,
): Promise<Result<StoredAsset>> {
  const first = inspectImage(uploaded);
  if (!first.ok) return fail("invalid", first.message, "image");
  // Metadata (EXIF/GPS, comments, text chunks) never reaches the database: store, hash and de-duplicate the stripped bytes.
  const bytes = stripImageMetadata(uploaded);
  const check = bytes ? inspectImage(bytes) : first;
  if (!bytes || !check.ok) return fail("invalid", "The image file is damaged. Export it again as a PNG or JPEG.", "image");
  const { mime, width, height } = check.info;
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const stored = (id: string): Result<StoredAsset> => ok({ id, mime, width, height, byteSize: bytes.length });
  const sameBytes = and(eq(clinicAssets.tenantId, ctx.tenantId), eq(clinicAssets.kind, kind), eq(clinicAssets.sha256, sha256));

  const [existing] = await tx.select({ id: clinicAssets.id }).from(clinicAssets).where(sameBytes).limit(1);
  if (existing) return stored(existing.id);

  // Only a NEW image counts: a repeat of stored bytes returned above and still works at the cap.
  const [used] = await tx
    .select({ n: count() })
    .from(clinicAssets)
    .where(and(eq(clinicAssets.tenantId, ctx.tenantId), eq(clinicAssets.kind, kind)));
  if ((used?.n ?? 0) >= ASSET_CAPS[kind]) {
    return fail(
      "invalid",
      `This clinic has reached its limit of ${ASSET_CAPS[kind]} saved ${kind} images. Reuse one you uploaded before.`,
      "image",
    );
  }

  const [row] = await tx
    .insert(clinicAssets)
    .values({
      tenantId: ctx.tenantId,
      kind,
      mime,
      width,
      height,
      byteSize: bytes.length,
      sha256,
      bytes: Buffer.from(bytes),
      createdBy: ctx.userId,
    })
    .onConflictDoNothing({ target: [clinicAssets.tenantId, clinicAssets.kind, clinicAssets.sha256] })
    .returning({ id: clinicAssets.id });
  if (row) return stored(row.id);
  // A concurrent upload of the same bytes won the race: use its row.
  const [winner] = await tx.select({ id: clinicAssets.id }).from(clinicAssets).where(sameBytes).limit(1);
  return winner ? stored(winner.id) : fail("conflict", "The image could not be saved. Try again.");
}

/** True when `id` is an asset of this tenant and of exactly this kind (the database foreign key checks neither kind). */
export async function assetHasKind(tx: TenantTx, tenantId: string, id: string, kind: AssetKind): Promise<boolean> {
  const [row] = await tx
    .select({ id: clinicAssets.id })
    .from(clinicAssets)
    .where(and(eq(clinicAssets.tenantId, tenantId), eq(clinicAssets.id, id), eq(clinicAssets.kind, kind)))
    .limit(1);
  return Boolean(row);
}
