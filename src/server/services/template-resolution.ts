import { and, eq } from "drizzle-orm";
import { fail, ok, type Result } from "@/lib/result";
import { overlayDefinitionSchema, overlayGeometryIssues, type OverlayDefinition } from "@/lib/rx-render/overlay-definition";
import {
  PAD_TEMPLATES,
  LABEL_LANGUAGES,
  PAPER_SIZES,
  pickOption,
  type LabelLanguage,
  type OverlayInput,
  type PadLayout,
  type PaperSize,
} from "@/lib/rx-render/types";
import { clinics, doctors, templateFiles, templates, templateVersions } from "@/server/db/schema";
import type { TenantTx } from "@/server/db/tenant";
import { templateContentSha256 } from "@/server/templates/content-hash";
import { fileAsImageAsset, loadTemplateFileIn } from "./template-files";

/** Shown when a frozen pad no longer matches what was signed: never print something else instead. */
export const TEMPLATE_DAMAGED_MESSAGE = "This prescription's pad template is damaged, so it cannot be printed. Contact support.";
/**
 * Shown when the custom pad that applies to the signer cannot be used (at finalize nothing is finalized and no number is
 * used; in a draft preview nothing is shown). The wording fits both.
 */
export const TEMPLATE_UNUSABLE_MESSAGE =
  "The custom pad for this prescription cannot be used right now. Ask the clinic owner to publish the pad again or switch to a built-in pad.";

type ClinicRow = typeof clinics.$inferSelect;
type DoctorRow = typeof doctors.$inferSelect;

const oneOf = <T extends string>(options: readonly T[], value: string): T | null => ((options as readonly string[]).includes(value) ? (value as T) : null);

/**
 * The stored definition under the FROZEN v1 parser, with no geometry re-check (override 5): a published version was
 * checked when it was published, and its content hash (verified by the callers) proves it has not changed since.
 */
function parseStoredDefinition(value: unknown): OverlayDefinition | null {
  try {
    const parsed = overlayDefinitionSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** The built-in pad chosen in the clinic's settings (Plan 1C behaviour, unchanged). */
export function builtinLayout(clinic: ClinicRow | null): PadLayout {
  return {
    template: { kind: "builtin", key: pickOption(PAD_TEMPLATES, clinic?.rxTemplate, "general") },
    paperSize: pickOption(PAPER_SIZES, clinic?.rxPaperSize, "A4"),
    labels: pickOption(LABEL_LANGUAGES, clinic?.rxLabels, "en"),
  };
}

/**
 * Which pad a prescription signed by `doctor` prints on (decision 9): the doctor's own template, then the clinic
 * default, then the built-in pad. A template is usable when it is active and has a published current version; the
 * identity binding is read from that VERSION (override 2): a bound version is used only for its own doctor and
 * skipped (never used) for anyone else. A usable version whose stored content no longer matches its hash fails closed.
 * Plain reads, no locks: published versions never change.
 */
export async function resolveTemplateIn(tx: TenantTx, tenantId: string, clinic: ClinicRow | null, doctor: DoctorRow | null): Promise<Result<PadLayout>> {
  const candidates = [doctor?.templateId ?? null, clinic?.customTemplateId ?? null].filter(
    (id, i, all): id is string => id !== null && all.indexOf(id) === i,
  );
  for (const templateId of candidates) {
    const [template] = await tx.select().from(templates).where(and(eq(templates.tenantId, tenantId), eq(templates.id, templateId))).limit(1);
    if (!template || template.kind !== "overlay" || template.status !== "active" || template.currentVersionId === null) continue;
    const [version] = await tx
      .select()
      .from(templateVersions)
      .where(and(eq(templateVersions.tenantId, tenantId), eq(templateVersions.id, template.currentVersionId)))
      .limit(1);
    if (!version) return fail("invalid", TEMPLATE_UNUSABLE_MESSAGE);
    if (version.identity === "bound" && (doctor === null || version.boundDoctorId !== doctor.id)) continue;
    const paperSize: PaperSize | null = oneOf(PAPER_SIZES, version.paperSize);
    const labels: LabelLanguage | null = oneOf(LABEL_LANGUAGES, version.labels);
    const definition = parseStoredDefinition(version.definition);
    const [file] = await tx
      .select({ sha256: templateFiles.sha256 })
      .from(templateFiles)
      .where(and(eq(templateFiles.tenantId, tenantId), eq(templateFiles.id, version.fileId)))
      .limit(1);
    if (version.state !== "published" || !version.contentSha256 || !paperSize || !labels || !definition || !file) {
      return fail("invalid", TEMPLATE_UNUSABLE_MESSAGE);
    }
    // Finalizing is the one place the geometry is checked again (override 21d): a pad that no longer fits its paper
    // fails closed here and burns no Rx number; reprints never re-check (the hash proves the stored content).
    if (overlayGeometryIssues(definition, paperSize).length > 0) return fail("invalid", TEMPLATE_UNUSABLE_MESSAGE);
    const contentSha256 = templateContentSha256({ kind: "overlay", paperSize, labels, definition, fileSha256: file.sha256 });
    if (contentSha256 !== version.contentSha256) return fail("invalid", TEMPLATE_UNUSABLE_MESSAGE);
    return ok({ template: { kind: "overlay", templateVersionId: version.id, contentSha256 }, paperSize, labels });
  }
  return ok(builtinLayout(clinic));
}

/**
 * The exact template a document names, re-verified byte for byte (spec section 5.4): the version must be published and
 * carry the frozen hash, the file bytes must match their hash (loadTemplateFileIn), and the hash recomputed from the
 * stored definition (frozen v1 parser, no geometry re-check) and the file must equal the snapshot's. null on any
 * mismatch: the caller fails closed.
 */
/**
 * The stored definition of the version a snapshot pins, without the background file (for notices on the prescription
 * page). Parsed by the frozen v1 parser; null for a built-in pad, a missing version or a definition that does not parse.
 */
export async function loadPinnedDefinitionIn(tx: TenantTx, tenantId: string, layout: PadLayout): Promise<OverlayDefinition | null> {
  if (layout.template.kind !== "overlay") return null;
  const [version] = await tx
    .select({ definition: templateVersions.definition })
    .from(templateVersions)
    .where(and(eq(templateVersions.tenantId, tenantId), eq(templateVersions.id, layout.template.templateVersionId)))
    .limit(1);
  return version ? parseStoredDefinition(version.definition) : null;
}

export async function loadOverlayIn(tx: TenantTx, tenantId: string, layout: PadLayout): Promise<OverlayInput | null> {
  if (layout.template.kind !== "overlay") return null;
  const ref = layout.template;
  const [version] = await tx
    .select()
    .from(templateVersions)
    .where(and(eq(templateVersions.tenantId, tenantId), eq(templateVersions.id, ref.templateVersionId)))
    .limit(1);
  if (!version || version.state !== "published" || version.contentSha256 !== ref.contentSha256) return null;
  if (version.paperSize !== layout.paperSize || version.labels !== layout.labels) return null;
  const definition = parseStoredDefinition(version.definition);
  const file = definition ? await loadTemplateFileIn(tx, tenantId, version.fileId) : null;
  if (!definition || !file) return null;
  const contentSha256 = templateContentSha256({ kind: "overlay", paperSize: layout.paperSize, labels: layout.labels, definition, fileSha256: file.sha256 });
  if (contentSha256 !== ref.contentSha256) return null;
  return { templateVersionId: version.id, definition, background: fileAsImageAsset(file) };
}
