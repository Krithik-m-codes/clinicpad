import { formatIssuedDate, numberText } from "./format";
import { html, raw, userText, type SafeHtml } from "./html";
import { ageText, draftAmendmentText, genderText, labelText, replacesVersionText } from "./labels";
import { documentCss } from "./styles";
import { DOCUMENT_CSP, documentTitle, footerTemplate, image, positive, present, rxNoText, type Ctx } from "./common";
import { signature, snapshotNote, statusBanner, watermark } from "./marks";
import { allergies, kv, section } from "./sections";
import type { SectionKey } from "./templates";
import type { RenderedDocument } from "./types";

export function renderBuiltin(c: Ctx): RenderedDocument {
  const title = documentTitle(c.doc);
  const sections = c.def.sections
    .map((key) => ({ key, markup: section(c, key) }))
    .filter((entry): entry is { key: SectionKey; markup: SafeHtml } => entry.markup !== null);
  // The signature stays with the last block of text; a long medicine table is never wrapped (it cannot stay together).
  const last = sections.length > 0 && sections[sections.length - 1].key !== "medicines" ? sections.pop() : undefined;
  const page = html`<!doctype html>
<html lang="${c.lang === "en" ? "en" : "hi"}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${DOCUMENT_CSP}">
<title>${title}</title>
<style>${raw(c.assets.fontCss)}
${raw(documentCss(c.def, c.paper))}</style>
</head>
<body class="tpl-${c.def.key} paper-${c.paper.size.toLowerCase()} status-${c.doc.status}" data-rx="ready">
${watermark(c)}
<table class="sheet">
<thead><tr><td>${padHeader(c)}${patientStrip(c)}</td></tr></thead>
${padFooter(c)}
<tbody><tr><td>
${allergies(c)}
<div class="rx-mark">R<span>x</span></div>
${sections.map((entry) => entry.markup)}
<div class="closing">${last?.markup}${signature(c)}</div>
${snapshotNote(c)}
</td></tr></tbody>
</table>
</body>
</html>
`;
  return { format: "html", html: page.value, footerHtml: footerTemplate(c.doc, c.paper), paper: c.paper, title };
}

function padHeader(c: Ctx): SafeHtml {
  const { clinic, doctor } = c.doc.snapshot;
  const logo = image(c.assets.logo);
  return html`<header class="pad-head">
<div class="head-row">
<div class="doc">
<div class="doc-name">${userText(doctor.name)}</div>
${present(doctor.qualifications) ? html`<div class="doc-line">${userText(doctor.qualifications)}</div>` : null}
${present(doctor.designation) ? html`<div class="doc-line">${userText(doctor.designation)}</div>` : null}
${present(doctor.registrationNo) ? html`<div class="doc-line">${labelText("regNo", c.lang)}: ${userText(doctor.registrationNo)}${present(doctor.registrationCouncil) ? html` (${userText(doctor.registrationCouncil)})` : null}</div>` : null}
</div>
${logo ? html`<div class="logo">${logo}</div>` : null}
<div class="clinic">
<div class="clinic-name">${userText(clinic.name)}</div>
${clinic.addressLines.filter(present).map((line) => html`<div class="clinic-line">${userText(line)}</div>`)}
${present(clinic.phone) ? html`<div class="clinic-line">${labelText("phone", c.lang)}: ${userText(clinic.phone)}</div>` : null}
${present(clinic.email) ? html`<div class="clinic-line">${userText(clinic.email)}</div>` : null}
</div>
</div>
${statusBanner(c)}
</header>`;
}

function padFooter(c: Ctx): SafeHtml | null {
  const lines = c.doc.snapshot.clinic.footerLines.filter(present);
  if (lines.length === 0) return null;
  return html`<tfoot><tr><td><footer class="pad-foot">${lines.map((line) => html`<div>${userText(line)}</div>`)}</footer></td></tr></tfoot>`;
}

/** Repeats on every printed page (it sits in the table header): who, when, and which Rx. */
function patientStrip(c: Ctx): SafeHtml {
  const { doc, lang } = c;
  const patient = doc.snapshot.patient;
  const age = ageText(patient.ageLabel, lang);
  const gender = genderText(patient.gender, lang);
  const weightValue = c.def.prominentWeight ? numberText(doc.visit.vitals.weightKg, 1) : "";
  const weight = weightValue !== "" && Number(weightValue) > 0 ? `${weightValue} kg` : "";
  const date = formatIssuedDate(doc.issuedAt ?? doc.snapshot.takenAt, doc.snapshot.clinic.timezone);
  const rxNo = rxNoText(doc);
  const relation = positive(doc.replacesVersion)
    ? doc.status === "draft"
      ? draftAmendmentText(doc.replacesVersion, lang)
      : replacesVersionText(doc.replacesVersion, lang)
    : "";
  return html`<section class="patient">
<div class="patient-main">
<div class="kv"><span class="k">${labelText("name", lang)}:</span> <b>${userText(patient.name)}</b></div>
${age ? kv(c, "age", age) : null}
${gender ? kv(c, "gender", gender) : null}
${weight ? kv(c, "weight", weight) : null}
${patient.patientNo !== null ? kv(c, "patientNo", String(patient.patientNo)) : null}
</div>
<div class="patient-meta">
${date ? kv(c, "date", date) : null}
${rxNo ? kv(c, "rxNo", rxNo) : null}
${relation ? html`<div class="small">${relation}</div>` : null}
</div>
</section>`;
}
