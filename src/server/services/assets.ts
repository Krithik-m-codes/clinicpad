import { inArray } from "drizzle-orm";
import { clinicAssets } from "@/server/db/schema";
import type { TenantTx } from "@/server/db/tenant";
import type { ImageAsset } from "@/lib/rx-render/types";

export type AssetPreview = { id: string; dataUrl: string; width: number; height: number };

function asMime(value: string): ImageAsset["mime"] | null {
  return value === "image/png" || value === "image/jpeg" ? value : null;
}

/** Loads images by id through RLS (another clinic's ids simply are not found). */
export async function loadImageAssets(tx: TenantTx, ids: (string | null)[]): Promise<Map<string, ImageAsset>> {
  const wanted = [...new Set(ids.filter((id): id is string => id !== null))];
  const found = new Map<string, ImageAsset>();
  if (wanted.length === 0) return found;
  const rows = await tx
    .select({ id: clinicAssets.id, mime: clinicAssets.mime, width: clinicAssets.width, height: clinicAssets.height, bytes: clinicAssets.bytes })
    .from(clinicAssets)
    .where(inArray(clinicAssets.id, wanted));
  for (const row of rows) {
    const mime = asMime(row.mime);
    if (mime) found.set(row.id, { mime, width: row.width, height: row.height, base64: row.bytes.toString("base64") });
  }
  return found;
}

export function assetPreview(id: string, asset: ImageAsset): AssetPreview {
  return { id, dataUrl: `data:${asset.mime};base64,${asset.base64}`, width: asset.width, height: asset.height };
}
