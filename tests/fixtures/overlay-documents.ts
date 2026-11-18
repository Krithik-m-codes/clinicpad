import { defaultOverlayDefinition, overlayDefinitionSchema, type OverlayDefinition } from "@/lib/rx-render/overlay-definition";
import type { OverlayInput, RxDocument } from "@/lib/rx-render/types";
import { MINIMAL_OVERLAY_DEFINITION } from "./overlay-definitions";
import { TINY_PNG, documentFixture } from "./rx-documents";

export const OVERLAY_VERSION_ID = "019a5c00-0000-7000-8000-00000000a001";
export const OVERLAY_HASH = "ab".repeat(32);

/** The minimal A4 definition, parsed, with top-level parts replaced. */
export function overlayDefinition(patch: Partial<OverlayDefinition> = {}): OverlayDefinition {
  return overlayDefinitionSchema.parse({ ...structuredClone(MINIMAL_OVERLAY_DEFINITION), ...patch });
}

export const a5Definition = (): OverlayDefinition => defaultOverlayDefinition("A5");

export function overlayInput(definition: OverlayDefinition = overlayDefinition()): OverlayInput {
  return { templateVersionId: OVERLAY_VERSION_ID, definition, background: TINY_PNG };
}

/** A finalized prescription for the overlay above (Task 13 points its layout at OVERLAY_VERSION_ID). */
export function overlayDocument(overrides: Parameters<typeof documentFixture>[0] = {}): RxDocument {
  return documentFixture(overrides);
}
