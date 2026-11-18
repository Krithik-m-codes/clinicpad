import { renderBuiltin } from "./builtin";
import { OVERLAY_RENDERER_VERSION, renderOverlay } from "./overlay";
import { PAPER } from "./paper";
import { TEMPLATE_DEFINITIONS } from "./templates";
import type { RenderAssets, RenderedDocument, RenderTarget, RxDocument, TemplateRef } from "./types";

export { DOCUMENT_CSP, footerTemplate } from "./common";

/**
 * Bump when templates, labels, CSS, fonts or layout change in a way that alters printed output.
 * The document DATA is frozen at finalize (the snapshot); the PRESENTATION of built-in pads is not, so every
 * output row records the version that drew it (prescription_outputs.renderer_version).
 */
export const RENDERER_VERSION = "1";

/** Renderer version per template kind, logged with every output (pinned: a frozen overlay reprints with its renderer). */
export const RENDERER_VERSIONS = { builtin: RENDERER_VERSION, overlay: OVERLAY_RENDERER_VERSION } as const;

export function rendererVersionFor(template: TemplateRef): string {
  return RENDERER_VERSIONS[template.kind];
}

export type RenderOptions = { target?: RenderTarget; sample?: boolean };

/**
 * Renders a prescription pad as one self-contained HTML document. Pure: the same input gives byte-identical output.
 * Dispatches on the template kind (the switch has no default: a new TemplateRef kind fails to compile until it is
 * drawn). An overlay prints only with the exact template version the snapshot names, loaded and verified by the
 * server; anything else is a programming error. Safety rules: src/lib/rx-render/common.ts.
 */
export function renderPrescription(doc: RxDocument, assets: RenderAssets, options: RenderOptions = {}): RenderedDocument {
  const { template, paperSize, labels } = doc.snapshot.layout;
  switch (template.kind) {
    case "builtin":
      return renderBuiltin({ doc, def: TEMPLATE_DEFINITIONS[template.key], lang: labels, assets, paper: PAPER[paperSize] });
    case "overlay": {
      const overlay = assets.overlay;
      if (!overlay || overlay.templateVersionId !== template.templateVersionId) {
        throw new Error("renderPrescription: the overlay template for this document was not loaded");
      }
      return renderOverlay(doc, assets, overlay, { target: options.target ?? "screen", sample: options.sample === true });
    }
  }
}
