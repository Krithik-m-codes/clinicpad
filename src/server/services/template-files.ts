import { createHash } from "node:crypto";
import { and, eq, lt, sql } from "drizzle-orm";
import { inspectBackground, stripImageMetadata, type ImageMime } from "@/lib/domain/image";
import { can } from "@/lib/domain/permissions";
import { isUuid } from "@/lib/domain/ids";
import { fail, ok, type Result } from "@/lib/result";
import type { ImageAsset } from "@/lib/rx-render/types";
import { templateFiles, templateVersions } from "@/server/db/schema";
import { pgErrorInfo } from "@/server/db/errors";
import { withTenant, type TenantTx } from "@/server/db/tenant";
import type { MalwareScanner } from "@/server/scanning/scanner";
import { scanOrRefuse } from "@/server/scanning/uploads";
import { recordAudit } from "./audit";
import type { ServiceContext } from "./context";

/** Per-tenant limits (decision 7), exact under lockTemplateQuota(). */
export const TEMPLATE_QUOTAS = { activeTemplates: 20, versions: 100, fileBytes: 50 * 1024 * 1024 } as const;
/** Files no version uses are deleted at the next upload once they are this old (the database refuses younger than a day). */
export const UNUSED_FILE_DAYS = 30;

export const TEMPLATE_UPLOAD_MESSAGES = {
  forbidden: "You cannot upload pad templates.",
  damaged: "The image file is damaged. Export it again as a PNG or JPEG.",
  quota: `This clinic has used its ${TEMPLATE_QUOTAS.fileBytes / 1024 / 1024} MB for pad images. Images that no pad version uses are removed after ${UNUSED_FILE_DAYS} days; until then ask us to raise the limit.`,
  notFound: "File not found.",
} as const;

export type StoredTemplateFile = { id: string; mime: ImageMime; width: number; height: number; byteSize: number; reused: boolean };
export type LoadedTemplateFile = { id: string; mime: ImageMime; width: number; height: number; sha256: string; bytes: Buffer };

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/**
 * Serializes everything that counts against a clinic's template quotas (files, templates, versions). Take it before
 * any row lock (decision 20). Released at commit.
 */
export async function lockTemplateQuota(tx: TenantTx, tenantId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`clinicpad:template-quota:${tenantId}`}, 0))`);
}

async function audit(ctx: ServiceContext, action: string, after: Record<string, unknown>): Promise<void> {
  await withTenant(ctx.tenantId, (tx) => recordAudit(tx, ctx, { action, entityType: "template_file", after }));
}

/** Deletes this clinic's files that no version uses and that are older than UNUSED_FILE_DAYS, in a savepoint. */
async function collectUnusedFiles(tx: TenantTx, tenantId: string, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - UNUSED_FILE_DAYS * 86_400_000);
  try {
    return await tx.transaction(async (sp) => {
      const gone = await sp
        .delete(templateFiles)
        .where(
          and(
            eq(templateFiles.tenantId, tenantId),
            lt(templateFiles.createdAt, cutoff),
            sql`not exists (select 1 from ${templateVersions} v where v.tenant_id = ${templateFiles.tenantId} and v.file_id = ${templateFiles.id})`,
          ),
        )
        .returning({ id: templateFiles.id });
      return gone.length;
    });
  } catch (error) {
    // A draft started using one of them meanwhile (23503) or a row is younger than the database allows (23000): keep
    // them all; the next upload tries again. Anything else is a bug.
    const { code } = pgErrorInfo(error);
    if (code !== "23503" && code !== "23000") throw error;
    return 0;
  }
}

/** Audits a refusal that happened before the service ran (the upload route): counts only, never content. */
export async function auditUploadRefusal(ctx: ServiceContext, reasonCode: "too_large" | "empty", byteSize: number | null): Promise<void> {
  await audit(ctx, "template_file.rejected", { kind: "background_image", reasonCode, byteSize });
}

/**
 * Validates, scans, strips and stores a pad background (spec section 8.2). The server trusts nothing the client did:
 * the bytes are identified from their content (no name or declared type is read), checked against the size, dimension
 * and proportion limits, scanned before any transaction, then metadata-stripped and re-checked; the stored bytes, hash
 * and size are those of the stripped image; identical bytes reuse the existing row.
 */
export async function uploadBackground(
  ctx: ServiceContext,
  uploaded: Uint8Array,
  deps: { scanner?: MalwareScanner; now?: Date; quotaBytes?: number } = {},
): Promise<Result<StoredTemplateFile>> {
  if (!can(ctx.role, "template.write")) return fail("forbidden", TEMPLATE_UPLOAD_MESSAGES.forbidden);
  const first = inspectBackground(uploaded);
  if (!first.ok) {
    await audit(ctx, "template_file.rejected", { kind: "background_image", reasonCode: "invalid_image", byteSize: uploaded.length });
    return fail("invalid", first.message, "file");
  }
  // Strip and re-inspect FIRST, then scan the bytes that will be stored (stripping is idempotent). The original is
  // scanned as well: it is what the client sent and the cheapest place to catch a known signature.
  const bytes = stripImageMetadata(uploaded);
  const check = bytes ? inspectBackground(bytes) : null;
  if (!bytes || !check?.ok) {
    await audit(ctx, "template_file.rejected", { kind: "background_image", reasonCode: "damaged", byteSize: uploaded.length });
    return fail("invalid", TEMPLATE_UPLOAD_MESSAGES.damaged, "file");
  }
  const scanAudit = { action: "template_file.rejected", entityType: "template_file", kind: "background_image", field: "file" };
  const original = await scanOrRefuse(ctx, uploaded, scanAudit, deps.scanner);
  if (!original.ok) return original;
  const scanned = Buffer.compare(Buffer.from(bytes), Buffer.from(uploaded)) === 0 ? original : await scanOrRefuse(ctx, bytes, scanAudit, deps.scanner);
  if (!scanned.ok) return scanned;
  const { mime, width, height } = check.info;
  const hash = sha256(bytes);
  const quotaBytes = deps.quotaBytes ?? TEMPLATE_QUOTAS.fileBytes;

  return withTenant(ctx.tenantId, async (tx): Promise<Result<StoredTemplateFile>> => {
    await lockTemplateQuota(tx, ctx.tenantId);
    const collected = await collectUnusedFiles(tx, ctx.tenantId, deps.now ?? new Date());
    if (collected > 0) await recordAudit(tx, ctx, { action: "template_file.collected", entityType: "template_file", after: { count: collected } });
    const [existing] = await tx
      .select({ id: templateFiles.id })
      .from(templateFiles)
      .where(and(eq(templateFiles.tenantId, ctx.tenantId), eq(templateFiles.kind, "background_image"), eq(templateFiles.sha256, hash)))
      .limit(1);
    if (existing) {
      await recordAudit(tx, ctx, {
        action: "template_file.uploaded",
        entityType: "template_file",
        entityId: existing.id,
        after: { fileId: existing.id, kind: "background_image", sha256: hash, reused: true },
      });
      return ok({ id: existing.id, mime, width, height, byteSize: bytes.length, reused: true });
    }
    const [used] = await tx
      .select({ total: sql<number>`coalesce(sum(${templateFiles.byteSize}), 0)::int` })
      .from(templateFiles)
      .where(eq(templateFiles.tenantId, ctx.tenantId));
    if ((used?.total ?? 0) + bytes.length > quotaBytes) {
      await recordAudit(tx, ctx, { action: "template_file.rejected", entityType: "template_file", after: { kind: "background_image", reasonCode: "quota", byteSize: bytes.length } });
      return fail("invalid", TEMPLATE_UPLOAD_MESSAGES.quota, "file");
    }
    const [row] = await tx
      .insert(templateFiles)
      .values({
        tenantId: ctx.tenantId,
        kind: "background_image",
        mime,
        width,
        height,
        byteSize: bytes.length,
        sha256: hash,
        bytes: Buffer.from(bytes),
        scanEngine: scanned.value.engine,
        createdBy: ctx.userId,
      })
      .returning({ id: templateFiles.id });
    await recordAudit(tx, ctx, {
      action: "template_file.uploaded",
      entityType: "template_file",
      entityId: row.id,
      after: { fileId: row.id, kind: "background_image", byteSize: bytes.length, sha256: hash, scanEngine: scanned.value.engine, width, height },
    });
    return ok({ id: row.id, mime, width, height, byteSize: bytes.length, reused: false });
  });
}

function asMime(value: string): ImageMime | null {
  return value === "image/png" || value === "image/jpeg" ? value : null;
}

/**
 * The only way template file bytes are read (the storage seam, ADR-0047). Filters on the tenant on top of RLS and
 * re-hashes the bytes: a row whose bytes do not match its hash is treated as missing (callers fail closed).
 */
export async function loadTemplateFileIn(tx: TenantTx, tenantId: string, fileId: string): Promise<LoadedTemplateFile | null> {
  if (!isUuid(fileId)) return null;
  const [row] = await tx
    .select()
    .from(templateFiles)
    .where(and(eq(templateFiles.tenantId, tenantId), eq(templateFiles.id, fileId)))
    .limit(1);
  const mime = row ? asMime(row.mime) : null;
  if (!row || !mime || row.storage !== "pg" || sha256(row.bytes) !== row.sha256) return null;
  return { id: row.id, mime, width: row.width, height: row.height, sha256: row.sha256, bytes: row.bytes };
}

export function fileAsImageAsset(file: LoadedTemplateFile): ImageAsset {
  return { mime: file.mime, width: file.width, height: file.height, base64: file.bytes.toString("base64") };
}

/** A file for Template Studio's editor (the background behind the boxes). */
export async function getTemplateFile(ctx: ServiceContext, fileId: string): Promise<Result<LoadedTemplateFile>> {
  if (!can(ctx.role, "template.read")) return fail("forbidden", TEMPLATE_UPLOAD_MESSAGES.notFound);
  if (!isUuid(fileId)) return fail("not_found", TEMPLATE_UPLOAD_MESSAGES.notFound);
  const file = await withTenant(ctx.tenantId, (tx) => loadTemplateFileIn(tx, ctx.tenantId, fileId));
  return file ? ok(file) : fail("not_found", TEMPLATE_UPLOAD_MESSAGES.notFound);
}
