import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { adminDb } from "@/server/db/admin";
import { templateFiles, templates, templateVersions } from "@/server/db/schema";
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

export async function insertBackgroundFile(tenantId: string, label: string, overrides: Partial<typeof templateFiles.$inferInsert> = {}): Promise<string> {
  const [row] = await adminDb.insert(templateFiles).values(fileValues(tenantId, label, overrides)).returning({ id: templateFiles.id });
  return row.id;
}

export type InsertedTemplate = { templateId: string; versionId: string; fileId: string };

/**
 * Admin insert of a template with one version: a draft, or (publish: true) flipped to published with a FAKE content hash.
 * The binding (identity, bound doctor, confirmation) lives on the VERSION and is set with the publish flip (override 2).
 * Schema tests only: services and the renderer verify real hashes (use Task 13's insertPublishedOverlay there).
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
    .values({ tenantId, templateId: template.id, version: opts.version ?? 1, fileId, definition: MINIMAL_OVERLAY_DEFINITION, paperSize: "A4", labels: "en" })
    .returning({ id: templateVersions.id });
  if (opts.publish) {
    await adminDb
      .update(templateVersions)
      .set({
        state: "published",
        identity,
        boundDoctorId: identity === "bound" ? (opts.boundDoctorId ?? null) : null,
        boundConfirmed: identity === "bound",
        contentSha256: "c".repeat(64),
        publishedAt: new Date(),
      })
      .where(eq(templateVersions.id, version.id));
    await adminDb.update(templates).set({ currentVersionId: version.id }).where(eq(templates.id, template.id));
  }
  return { templateId: template.id, versionId: version.id, fileId };
}
