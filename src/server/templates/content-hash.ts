import { createHash } from "node:crypto";
import { canonicalJson } from "@/lib/rx-render/canonical-json";
import type { OverlayDefinition } from "@/lib/rx-render/overlay-definition";
import type { LabelLanguage, PaperSize } from "@/lib/rx-render/types";

export type TemplateContent = { kind: "overlay"; paperSize: PaperSize; labels: LabelLanguage; definition: OverlayDefinition; fileSha256: string };

/**
 * The value a snapshot freezes (ADR-0045): SHA-256 of the canonical JSON of everything that decides how a custom pad
 * prints: the definition AS STORED (services store the parsed definition, lengths rounded and unknown keys dropped),
 * the paper, the labels, and the stored file's hash. The `v: 1` wrapper is frozen with the overlay v1 schema.
 */
export function templateContentSha256(content: TemplateContent): string {
  const canonical = canonicalJson({ v: 1, kind: content.kind, paperSize: content.paperSize, labels: content.labels, definition: content.definition, fileSha256: content.fileSha256 });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
