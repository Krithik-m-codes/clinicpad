import { formatCalendarDate } from "./format";
import { html, userText, type HtmlValue, type SafeHtml } from "./html";
import { labelText, type LabelKey } from "./labels";
import { joined, present, type Ctx } from "./common";
import { medicines } from "./medicines";
import type { SectionKey } from "./templates";
import { VITAL_LABEL, vitalText } from "./vitals";

export function kv(c: Ctx, key: LabelKey, value: string): SafeHtml {
  return html`<div class="kv"><span class="k">${labelText(key, c.lang)}:</span> ${userText(value)}</div>`;
}

export function allergies(c: Ctx): SafeHtml | null {
  const list = c.doc.snapshot.patient.allergies;
  if (!list.some(present)) return null;
  return html`<div class="allergies"><span class="k">${labelText("allergies", c.lang)}:</span> ${joined(list, ", ")}</div>`;
}

function vitalsBlock(c: Ctx): SafeHtml | null {
  const v = c.doc.visit.vitals;
  const parts = c.def.vitals
    .map((key) => {
      const value = vitalText(key, v);
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

export function section(c: Ctx, key: SectionKey): SafeHtml | null {
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
