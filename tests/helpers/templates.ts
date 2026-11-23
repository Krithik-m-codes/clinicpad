import { createHash, randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { adminDb } from "@/server/db/admin";
import { overlayDefinitionSchema } from "@/lib/rx-render/overlay-definition";
import { templateFiles, templates, templateVersions } from "@/server/db/schema";
import { templateContentSha256 } from "@/server/templates/content-hash";
import { MINIMAL_OVERLAY_DEFINITION } from "../fixtures/overlay-definitions";
import { makePng } from "./images";

export { MINIMAL_OVERLAY_DEFINITION };

/** A real PNG with A-series proportions (780 x 1103 px). The colour, and so the hash, is derived from the label. */
export function backgroundPng(label: string): Buffer {
  const seed = createHash("sha256").update(label).digest();
  return makePng(780, 1103, [seed[0], seed[1], seed[2]]);
}

export function fileValues(tenantId: string, label: string, overrides: Partial<typeof templateFiles.$inferInsert> = {}) {
  const bytes = backgroundPng(label);
  return {
    tenantId,
    kind: "background_image",
    mime: "image/png",
    width: 780,
    height: 1103,
    byteSize: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes,
    scanEngine: "test-scanner 1.0",
    ...overrides,
  };
}

/**
 * Inserts a stored file. The database forces created_at to now() on insert (0027), so a backdated file (garbage
 * collection tests) is written with triggers off, which only the superuser connection may do (replica mode, tests only).
 */
export async function insertBackgroundFile(tenantId: string, label: string, overrides: Partial<typeof templateFiles.$inferInsert> = {}): Promise<string> {
  const values = fileValues(tenantId, label, overrides);
  if (!overrides.createdAt) {
    const [row] = await adminDb.insert(templateFiles).values(values).returning({ id: templateFiles.id });
    return row.id;
  }
  return adminDb.transaction(async (tx) => {
    await tx.execute(sql`set local session_replication_role = replica`);
    const [row] = await tx.insert(templateFiles).values(values).returning({ id: templateFiles.id });
    return row.id;
  });
}

export type InsertedTemplate = { templateId: string; versionId: string; fileId: string };

/**
 * Admin insert of a template with one version: a draft, or (publish: true) flipped to published with a FAKE content hash.
 * The binding (identity, bound doctor, confirmation) lives on the VERSION (override 2): identity and boundDoctorId are
 * written with the draft either way (a bound draft needs its doctor), and the confirmation is set with the publish flip.
 * Schema tests only: services and the renderer verify real hashes (use insertPublishedOverlay there).
 */
export async function insertTemplate(
  tenantId: string,
  opts: { label?: string; version?: number; publish?: boolean; identity?: "dynamic" | "bound"; boundDoctorId?: string | null; fileId?: string } = {},
): Promise<InsertedTemplate> {
  const label = opts.label ?? `tpl-${Math.random().toString(36).slice(2)}`;
  const fileId = opts.fileId ?? (await insertBackgroundFile(tenantId, label));
  const identity = opts.identity ?? "dynamic";
  const [template] = await adminDb.insert(templates).values({ tenantId, name: "Test pad", kind: "overlay" }).returning({ id: templates.id });
  const [version] = await adminDb
    .insert(templateVersions)
    .values({
      tenantId,
      templateId: template.id,
      version: opts.version ?? 1,
      fileId,
      definition: MINIMAL_OVERLAY_DEFINITION,
      paperSize: "A4",
      labels: "en",
      identity,
      boundDoctorId: identity === "bound" ? (opts.boundDoctorId ?? null) : null,
    })
    .returning({ id: templateVersions.id });
  if (opts.publish) {
    await adminDb
      .update(templateVersions)
      .set({
        state: "published",
        boundConfirmed: identity === "bound",
        contentSha256: "c".repeat(64),
        publishedAt: new Date(),
        publishedBy: randomUUID(),
      })
      .where(eq(templateVersions.id, version.id));
    await adminDb.update(templates).set({ currentVersionId: version.id }).where(eq(templates.id, template.id));
  }
  return { templateId: template.id, versionId: version.id, fileId };
}

async function fileSha(fileId: string): Promise<string> {
  const [file] = await adminDb.select({ sha256: templateFiles.sha256 }).from(templateFiles).where(eq(templateFiles.id, fileId));
  return file.sha256;
}

/**
 * A published overlay template with a REAL content hash (what the services would write). The binding goes on the
 * version (override 2); publishNewVersion can publish later versions with another binding.
 */
export async function insertPublishedOverlay(
  tenantId: string,
  opts: { label?: string; identity?: "dynamic" | "bound"; boundDoctorId?: string | null; definition?: unknown; paperSize?: "A4" | "A5"; labels?: "en" | "hi" | "bilingual" } = {},
): Promise<InsertedTemplate & { contentSha256: string }> {
  const [template] = await adminDb.insert(templates).values({ tenantId, name: "Published pad", kind: "overlay" }).returning({ id: templates.id });
  const published = await publishNewVersion(tenantId, template.id, { ...opts, label: opts.label ?? `pub-${Math.random().toString(36).slice(2)}` });
  return { templateId: template.id, versionId: published.versionId, fileId: published.fileId, contentSha256: published.contentSha256 };
}

/** Publishes a further version of a template (a new background unless a file id is given) and makes it current. */
export async function publishNewVersion(
  tenantId: string,
  templateId: string,
  opts: {
    fileId?: string;
    label?: string;
    definition?: unknown;
    paperSize?: "A4" | "A5";
    labels?: "en" | "hi" | "bilingual";
    identity?: "dynamic" | "bound";
    boundDoctorId?: string | null;
  } = {},
): Promise<{ versionId: string; fileId: string; contentSha256: string }> {
  const rows = await adminDb.select({ version: templateVersions.version }).from(templateVersions).where(eq(templateVersions.templateId, templateId));
  const next = Math.max(0, ...rows.map((r) => r.version)) + 1;
  const paperSize = opts.paperSize ?? "A4";
  const labels = opts.labels ?? "en";
  const identity = opts.identity ?? "dynamic";
  const definition = overlayDefinitionSchema.parse(opts.definition ?? MINIMAL_OVERLAY_DEFINITION);
  const fileId = opts.fileId ?? (await insertBackgroundFile(tenantId, opts.label ?? `v${next}-${Math.random().toString(36).slice(2)}`));
  const contentSha256 = templateContentSha256({ kind: "overlay", paperSize, labels, definition, fileSha256: await fileSha(fileId) });
  const [version] = await adminDb
    .insert(templateVersions)
    .values({ tenantId, templateId, version: next, fileId, definition, paperSize, labels, identity, boundDoctorId: identity === "bound" ? (opts.boundDoctorId ?? null) : null })
    .returning({ id: templateVersions.id });
  await adminDb
    .update(templateVersions)
    .set({ state: "published", boundConfirmed: identity === "bound", contentSha256, publishedAt: new Date(), publishedBy: randomUUID() })
    .where(eq(templateVersions.id, version.id));
  await adminDb.update(templates).set({ currentVersionId: version.id }).where(eq(templates.id, templateId));
  return { versionId: version.id, fileId, contentSha256 };
}
