import { formatIssuedDate } from "./format";
import { html, userText, type SafeHtml } from "./html";
import { labelText, statusText, supersededByText } from "./labels";
import { image, isSuperseded, positive, present, type Ctx } from "./common";

export function watermark(c: Ctx): SafeHtml | null {
  if (c.doc.status === "draft") return html`<div class="watermark">${statusText("draftWatermark", c.lang)}</div>`;
  if (isSuperseded(c.doc)) return html`<div class="watermark">${statusText("supersededWatermark", c.lang)}</div>`;
  return null;
}

export function statusBanner(c: Ctx): SafeHtml | null {
  const { doc, lang } = c;
  if (doc.status === "draft") return html`<div class="banner banner-draft">${statusText("draftBanner", lang)}</div>`;
  if (doc.supersededBy && positive(doc.supersededBy.version)) {
    const issued = doc.supersededBy.issuedAt ? formatIssuedDate(doc.supersededBy.issuedAt, doc.snapshot.clinic.timezone) : "";
    return html`<div class="banner banner-superseded">${supersededByText(doc.supersededBy.version, issued, lang)}</div>`;
  }
  if (isSuperseded(doc)) return html`<div class="banner banner-superseded">${statusText("supersededNewer", lang)}</div>`;
  return null;
}

/**
 * A draft is never signed: it prints the would-be signer (the viewer's own doctor profile, supplied by the loader
 * only when the viewer can finalize) as text and NEVER a signature image, even if one is passed in. With no
 * would-be signer it says "Not signed". A finalized document prints its frozen snapshot.
 */
export function signature(c: Ctx): SafeHtml {
  const doctor = c.doc.snapshot.doctor;
  const draft = c.doc.status === "draft";
  const named = present(doctor.name);
  return html`<div class="sig">
<div class="sig-box">${draft ? null : image(c.assets.signature)}</div>
<div class="sig-name">${draft && !named ? statusText("notSignedDraft", c.lang) : userText(doctor.name)}</div>
${present(doctor.registrationNo) ? html`<div class="sig-line">${labelText("regNo", c.lang)}: ${userText(doctor.registrationNo)}</div>` : null}
</div>`;
}

export function snapshotNote(c: Ctx): SafeHtml | null {
  if (c.doc.status === "draft" || c.doc.snapshotSource !== "live") return null;
  return html`<p class="note">${statusText("legacyNote", c.lang)}</p>`;
}
