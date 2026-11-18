import { renderBuiltin } from "./builtin";
import { PAPER } from "./paper";
import { TEMPLATE_DEFINITIONS } from "./templates";
import type { RenderAssets, RenderedDocument, RxDocument } from "./types";

export { DOCUMENT_CSP, footerTemplate } from "./common";

/**
 * Bump when templates, labels, CSS, fonts or layout change in a way that alters printed output.
 * The document DATA is frozen at finalize (the snapshot); the PRESENTATION is not, so every
 * output row records the version that drew it (prescription_outputs.renderer_version).
 */
export const RENDERER_VERSION = "1";

/**
 * Renders a prescription pad as one self-contained HTML document. Pure: the same input gives
 * byte-identical output. Dispatches on the template kind (the switch has no default: a new
 * TemplateRef kind fails to compile until it is drawn). Safety rules: src/lib/rx-render/common.ts.
 */
export function renderPrescription(doc: RxDocument, assets: RenderAssets): RenderedDocument {
  const { template, paperSize, labels } = doc.snapshot.layout;
  switch (template.kind) {
    case "builtin":
      return renderBuiltin({ doc, def: TEMPLATE_DEFINITIONS[template.key], lang: labels, assets, paper: PAPER[paperSize] });
  }
}
