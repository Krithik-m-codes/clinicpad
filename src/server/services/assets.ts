import { and, eq, inArray } from "drizzle-orm";
import { clinicAssets } from "@/server/db/schema";
import type { TenantTx } from "@/server/db/tenant";
import type { ImageAsset } from "@/lib/rx-render/types";

export type AssetPreview = { id: string; dataUrl: string; width: number; height: number };

function asMime(value: string): ImageAsset["mime"] | null {
  return value === "image/png" || value === "image/jpeg" ? value : null;
}

export type AssetRequest = { id: string | null; kind: "logo" | "signature" };

/**
 * Loads images by id. The caller says what each image must be (a logo is never served as a signature)
 * and which tenant it belongs to; both filters apply on top of row-level security, so another clinic's
 * ids, or an id of the wrong kind, are simply not found.
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
      if (mime) found.set(row.id, { mime, width: row.width, height: row.height, base64: row.bytes.toString("base64") });
    }
  }
  return found;
}

export function assetPreview(id: string, asset: ImageAsset): AssetPreview {
  return { id, dataUrl: `data:${asset.mime};base64,${asset.base64}`, width: asset.width, height: asset.height };
}
