import type { Vitals } from "@/lib/domain/rx-options";
import { bmiText, bpText, formatCalendarDate, formatIssuedDate, hasSlots, numberText, quantityText, scheduleText } from "./format";
import { html, raw, userText, type HtmlValue, type SafeHtml } from "./html";
import {
  ageText,
  draftAmendmentText,
  durationText,
  foodText,
  genderText,
  labelHtml,
  labelText,
  periodicityText,
  replacesVersionText,
  statusText,
  supersededByText,
  type LabelKey,
} from "./labels";
import { PAPER } from "./paper";
import { documentCss } from "./styles";
import { TEMPLATE_DEFINITIONS, type SectionKey, type TemplateDefinition, type VitalKey } from "./templates";
import type { ImageAsset, LabelLanguage, PaperSpec, RenderAssets, RenderedDocument, RxDocument, RxItem } from "./types";

/** Nothing may load: styles are inline, fonts and images are data: URIs, there are no scripts. */
export const DOCUMENT_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'";

type Ctx = { doc: RxDocument; def: TemplateDefinition; lang: LabelLanguage; assets: RenderAssets; paper: PaperSpec };

/**
 * Renders a prescription pad as one self-contained HTML document. Pure: the same input gives
 * byte-identical output. Dispatches on the template kind so Phase 2 kinds slot in here (the switch
 * has no default: a new TemplateRef kind fails to compile until it is drawn).
 *
 * Safety rules for this file: user text only through userText() or as a plain string in element
 * text; attribute values are plain strings (never SafeHtml); no user data in CSS or style
 * attributes (the stylesheet comes from documentCss(), built from fixed definitions). Every
 * user value that sits beside other text gets its OWN userText() span (see joined()): one
 * isolated span around several values would let right-to-left text reorder digits after it.
 */
export function renderPrescription(doc: RxDocument, assets: RenderAssets): RenderedDocument {
  const { template, paperSize, labels } = doc.snapshot.layout;
  switch (template.kind) {
    case "builtin":
      return renderBuiltin({ doc, def: TEMPLATE_DEFINITIONS[template.key], lang: labels, assets, paper: PAPER[paperSize] });
  }
}

const positive = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n > 0;
const present = (value: string | null | undefined): value is string => typeof value === "string" && value.trim() !== "";

/** A drafted prescription (including an amendment draft that carries its parent's number) has no Rx number. */
function printedRxNo(doc: RxDocument): number | null {
  return doc.status !== "draft" && positive(doc.rxNo) ? doc.rxNo : null;
}

function documentTitle(doc: RxDocument): string {
  const no = printedRxNo(doc);
  return `Prescription ${no !== null ? `Rx-${no}` : "draft"}${positive(doc.version) ? ` v${doc.version}` : ""}`;
}

/** Every present part in its own isolated user-text span, joined by plain separator text. */
function joined(parts: Array<string | null | undefined>, separator: string): HtmlValue[] {
  const out: HtmlValue[] = [];
  for (const part of parts) {
    if (!present(part)) continue;
    if (out.length > 0) out.push(separator);
    out.push(userText(part.trim()));
  }
  return out;
}

function renderBuiltin(c: Ctx): RenderedDocument {
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

/** Gotenberg's Chromium footer: page numbers and the Rx number only (no user text, system font is fine). */
export function footerTemplate(doc: RxDocument, paper: PaperSpec): string {
  const no = printedRxNo(doc);
  const version = positive(doc.version) ? ` v${doc.version}` : "";
  const id = no !== null ? `Rx ${no}${version}` : "Draft";
  const side = `${paper.marginMm.left}mm`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;width:100%;font-family:sans-serif;font-size:7pt;color:#555}.f{display:flex;justify-content:space-between;padding:0 ${side}}</style></head><body><div class="f"><span>${id}</span><span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div></body></html>`;
}

/** An embedded PNG/JPEG, or null when the asset is not what it claims to be. The data URL is a plain attribute string. */
function image(asset: ImageAsset | null): SafeHtml | null {
  if (!asset) return null;
  if (asset.mime !== "image/png" && asset.mime !== "image/jpeg") return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(asset.base64)) return null;
  if (!Number.isSafeInteger(asset.width) || !Number.isSafeInteger(asset.height) || asset.width <= 0 || asset.height <= 0) return null;
  const dataUrl = `data:${asset.mime};base64,${asset.base64}`;
  return html`<img src="${dataUrl}" alt="" width="${asset.width}" height="${asset.height}">`;
}

function isSuperseded(doc: RxDocument): boolean {
  return doc.supersededBy !== null || doc.status === "amended";
}

function watermark(c: Ctx): SafeHtml | null {
  if (c.doc.status === "draft") return html`<div class="watermark">${statusText("draftWatermark", c.lang)}</div>`;
  if (isSuperseded(c.doc)) return html`<div class="watermark">${statusText("supersededWatermark", c.lang)}</div>`;
  return null;
}

function statusBanner(c: Ctx): SafeHtml | null {
  const { doc, lang } = c;
  if (doc.status === "draft") return html`<div class="banner banner-draft">${statusText("draftBanner", lang)}</div>`;
  if (doc.supersededBy && positive(doc.supersededBy.version)) {
    const issued = doc.supersededBy.issuedAt ? formatIssuedDate(doc.supersededBy.issuedAt, doc.snapshot.clinic.timezone) : "";
    return html`<div class="banner banner-superseded">${supersededByText(doc.supersededBy.version, issued, lang)}</div>`;
  }
  if (isSuperseded(doc)) return html`<div class="banner banner-superseded">${statusText("supersededNewer", lang)}</div>`;
  return null;
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

function kv(c: Ctx, key: LabelKey, value: string): SafeHtml {
  return html`<div class="kv"><span class="k">${labelText(key, c.lang)}:</span> ${userText(value)}</div>`;
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
  const no = printedRxNo(doc);
  const showVersion = positive(doc.version) && (doc.version > 1 || isSuperseded(doc));
  const rxNo = no !== null ? (showVersion ? `${no} (v${doc.version})` : String(no)) : "";
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

function allergies(c: Ctx): SafeHtml | null {
  const list = c.doc.snapshot.patient.allergies;
  if (!list.some(present)) return null;
  return html`<div class="allergies"><span class="k">${labelText("allergies", c.lang)}:</span> ${joined(list, ", ")}</div>`;
}

const VITAL_LABEL: Record<VitalKey, LabelKey> = {
  bp: "bp",
  pulse: "pulse",
  temperatureF: "temperature",
  spo2: "spo2",
  respiratoryRate: "respiratoryRate",
  weightKg: "weight",
  heightCm: "height",
  bmi: "bmi",
  bloodSugarMgDl: "bloodSugar",
};

/** "70 kg", or null for a missing, damaged, zero or negative reading. */
function withUnit(value: number | undefined, decimals: number, unit: string): string | null {
  const text = numberText(value, decimals);
  return text === "" || text === "0" || text.startsWith("-") ? null : `${text}${unit}`;
}

const VITAL_VALUE: Record<VitalKey, (v: Vitals) => string | null> = {
  bp: (v) => {
    const bp = bpText(v.bpSystolic, v.bpDiastolic);
    return bp === "" ? null : `${bp} mmHg`;
  },
  pulse: (v) => withUnit(v.pulse, 0, "/min"),
  temperatureF: (v) => withUnit(v.temperatureF, 1, " °F"),
  spo2: (v) => withUnit(v.spo2, 0, "%"),
  respiratoryRate: (v) => withUnit(v.respiratoryRate, 0, "/min"),
  weightKg: (v) => withUnit(v.weightKg, 1, " kg"),
  heightCm: (v) => withUnit(v.heightCm, 1, " cm"),
  bmi: (v) => {
    const index = bmiText(v.weightKg, v.heightCm);
    return index === "" || index === "0" ? null : index;
  },
  bloodSugarMgDl: (v) => withUnit(v.bloodSugarMgDl, 0, " mg/dL"),
};

function vitalsBlock(c: Ctx): SafeHtml | null {
  const v = c.doc.visit.vitals;
  const parts = c.def.vitals
    .map((key) => {
      const value = VITAL_VALUE[key](v);
      return value === null ? null : html`<span class="vital"><span class="k">${labelText(VITAL_LABEL[key], c.lang)}</span> ${value}</span>`;
    })
    .filter((part): part is SafeHtml => part !== null);
  const notes = typeof v.notes === "string" ? v.notes : "";
  if (parts.length === 0 && notes.trim() === "") return null;
  return html`<div class="${c.def.compactVitals ? "vitals vitals-compact" : "vitals"}">${parts}${notes.trim() !== "" ? html`<span class="vital">${userText(notes)}</span>` : null}</div>`;
}

function line(c: Ctx, key: LabelKey, content: HtmlValue): SafeHtml {
  return html`<p class="line"><span class="k">${labelText(key, c.lang)}:</span> ${content}</p>`;
}

function textLine(c: Ctx, key: LabelKey, value: string | null): SafeHtml | null {
  return present(value) ? line(c, key, userText(value)) : null;
}

function listLine(c: Ctx, key: LabelKey, values: string[]): SafeHtml | null {
  return values.some(present) ? line(c, key, joined(values, ", ")) : null;
}

function block(c: Ctx, key: LabelKey, value: string | null): SafeHtml | null {
  if (!present(value)) return null;
  return html`<section class="block"><div class="block-title">${labelText(key, c.lang)}</div><div class="block-body">${userText(value)}</div></section>`;
}

function investigations(c: Ctx): SafeHtml | null {
  const tests = c.doc.visit.investigations.filter((t) => present(t.name));
  if (tests.length === 0) return null;
  return html`<section class="block"><div class="block-title">${labelText("investigations", c.lang)}</div><ol class="tests">${tests.map(
    (t) => html`<li>${userText(t.name)}${present(t.instructions) ? html` <span class="muted">(${userText(t.instructions)})</span>` : null}</li>`,
  )}</ol></section>`;
}

function followUp(c: Ctx): SafeHtml | null {
  const { followUpDate, followUpReason } = c.doc.visit;
  const date = formatCalendarDate(followUpDate);
  const reason = present(followUpReason) ? followUpReason : "";
  if (!date && !reason) return null;
  return line(c, "followUp", html`${date}${date && reason ? " · " : ""}${userText(reason)}`);
}

function section(c: Ctx, key: SectionKey): SafeHtml | null {
  const v = c.doc.visit;
  switch (key) {
    case "vitals":
      return vitalsBlock(c);
    case "chiefComplaint":
      return textLine(c, "chiefComplaint", v.chiefComplaint);
    case "complaints":
      return listLine(c, "complaints", v.complaints);
    case "medicalHistory":
      return listLine(c, "medicalHistory", v.medicalHistory);
    case "drugHistory":
      return listLine(c, "drugHistory", v.drugHistory);
    case "examination":
      return block(c, "examination", v.examinationNotes);
    case "diagnosis":
      return listLine(c, "diagnosis", v.diagnosis);
    case "medicines":
      return medicines(c);
    case "investigations":
      return investigations(c);
    case "advice":
      return block(c, "advice", v.advice);
    case "followUp":
      return followUp(c);
  }
}

/** The dose slots as "1-0-1" (empty without slots), and the free-text timing: both are printed, slots first. */
function scheduleParts(item: RxItem): [string, string] {
  const slots = hasSlots(item) ? scheduleText({ ...item, timing: null }) : "";
  return [slots, present(item.timing) ? item.timing.trim() : ""];
}

/** Name, then strength, form and route (eye drops are not ear drops), each in its own span. */
function medicineCell(c: Ctx, item: RxItem, index: number, show: { dose: boolean; remarks: boolean; timing: boolean }): SafeHtml {
  const spec = joined([item.strength, item.form], " ");
  const detail: HtmlValue[] = present(item.route) ? [...spec, spec.length > 0 ? " · " : "", userText(item.route.trim())] : spec;
  const timing = scheduleParts(item)[1];
  return html`<td class="med">
<div class="med-name">${index + 1}. ${userText(item.drugName)}${detail.length > 0 ? html` <span class="muted">${detail}</span>` : null}${item.isSos ? html` <span class="sos">SOS</span>` : null}</div>
${present(item.genericName) ? html`<div class="generic">${userText(item.genericName)}</div>` : null}
${show.dose && present(item.dose) ? html`<div class="small">${labelText("dose", c.lang)}: ${userText(item.dose)}</div>` : null}
${show.timing && timing !== "" ? html`<div class="small">${userText(timing)}</div>` : null}
${show.remarks && present(item.remarks) ? html`<div class="small">${userText(item.remarks)}</div>` : null}
</td>`;
}

function foodCell(c: Ctx, item: RxItem): SafeHtml {
  return html`<td class="center">${joined([foodText(item.foodRelation, c.lang)], "")}</td>`;
}

function frequencyCell(c: Ctx, item: RxItem): SafeHtml {
  return html`<td class="center">${joined([periodicityText(item.periodicity, c.lang), durationText(item.durationValue, item.durationUnit, c.lang)], " · ")}</td>`;
}

function medicines(c: Ctx): SafeHtml | null {
  if (c.doc.items.length === 0) return null;
  switch (c.def.medicineLayout) {
    case "slots":
      return slotsTable(c);
    case "pattern":
      return patternTable(c);
    case "topical":
      return topicalTable(c);
  }
}

function slotsTable(c: Ctx): SafeHtml {
  const { lang } = c;
  const rows = c.doc.items.map((item, i) => {
    const slots = hasSlots(item)
      ? html`<td class="slot">${quantityText(item.doseMorning)}</td><td class="slot">${quantityText(item.doseAfternoon)}</td><td class="slot">${quantityText(item.doseEvening)}</td><td class="slot">${quantityText(item.doseNight)}</td>`
      : html`<td class="slot-text" colspan="4">${userText(item.timing)}</td>`;
    // With slots the free-text timing goes under the medicine name (without slots it fills the dose columns).
    return html`<tr>${medicineCell(c, item, i, { dose: true, remarks: true, timing: hasSlots(item) })}${slots}${foodCell(c, item)}${frequencyCell(c, item)}</tr>`;
  });
  return html`<table class="meds meds-slots">
<colgroup><col class="c-med"><col class="c-slot"><col class="c-slot"><col class="c-slot"><col class="c-slot"><col class="c-food"><col class="c-freq"></colgroup>
<thead>
<tr><th rowspan="2" class="left">${labelHtml("medicine", lang)}</th><th colspan="4">${labelHtml("dose", lang)}</th><th rowspan="2">${labelHtml("food", lang)}</th><th rowspan="2">${labelHtml("frequencyDuration", lang)}</th></tr>
<tr><th>${labelHtml("morning", lang)}</th><th>${labelHtml("afternoon", lang)}</th><th>${labelHtml("evening", lang)}</th><th>${labelHtml("night", lang)}</th></tr>
</thead>
<tbody>${rows}</tbody>
</table>`;
}

function patternTable(c: Ctx): SafeHtml {
  const { lang } = c;
  const rows = c.doc.items.map(
    (item, i) =>
      html`<tr>${medicineCell(c, item, i, { dose: false, remarks: false, timing: false })}<td>${userText(item.dose)}</td><td class="when">${joined(scheduleParts(item), " · ")}</td>${foodCell(c, item)}${frequencyCell(c, item)}<td>${userText(item.remarks)}</td></tr>`,
  );
  return html`<table class="meds meds-pattern">
<colgroup><col class="c-med"><col class="c-dose"><col class="c-when"><col class="c-food"><col class="c-dur"><col class="c-rem"></colgroup>
<thead><tr><th class="left">${labelHtml("medicine", lang)}</th><th>${labelHtml("dose", lang)}</th><th>${labelHtml("when", lang)}</th><th>${labelHtml("food", lang)}</th><th>${labelHtml("frequencyDuration", lang)}</th><th>${labelHtml("remarks", lang)}</th></tr></thead>
<tbody>${rows}</tbody>
</table>`;
}

function topicalTable(c: Ctx): SafeHtml {
  const { lang } = c;
  const rows = c.doc.items.map((item, i) => {
    const [slots, timing] = scheduleParts(item);
    // The route is already printed with the medicine name; repeating it here would print it twice.
    const how = joined([item.dose, slots, timing, foodText(item.foodRelation, lang)], " · ");
    return html`<tr>${medicineCell(c, item, i, { dose: false, remarks: false, timing: false })}<td class="how">${how}</td>${frequencyCell(c, item)}<td>${userText(item.remarks)}</td></tr>`;
  });
  return html`<table class="meds meds-topical">
<colgroup><col class="c-med"><col class="c-how"><col class="c-dur"><col class="c-ins"></colgroup>
<thead><tr><th class="left">${labelHtml("medicine", lang)}</th><th>${labelHtml("howToUse", lang)}</th><th>${labelHtml("frequencyDuration", lang)}</th><th>${labelHtml("instructions", lang)}</th></tr></thead>
<tbody>${rows}</tbody>
</table>`;
}

function signature(c: Ctx): SafeHtml {
  const doctor = c.doc.snapshot.doctor;
  return html`<div class="sig">
<div class="sig-box">${image(c.assets.signature)}</div>
<div class="sig-name">${userText(doctor.name)}</div>
${present(doctor.registrationNo) ? html`<div class="sig-line">${labelText("regNo", c.lang)}: ${userText(doctor.registrationNo)}</div>` : null}
</div>`;
}

function snapshotNote(c: Ctx): SafeHtml | null {
  if (c.doc.status === "draft" || c.doc.snapshotSource !== "live") return null;
  return html`<p class="note">${statusText("legacyNote", c.lang)}</p>`;
}
