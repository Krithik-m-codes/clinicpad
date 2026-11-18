import { hasSlots, quantityText, scheduleText } from "./format";
import { html, userText, type HtmlValue, type SafeHtml } from "./html";
import { durationText, foodText, labelHtml, labelText, periodicityText } from "./labels";
import { joined, present, type Ctx } from "./common";
import type { RxItem } from "./types";

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

export function medicines(c: Ctx): SafeHtml | null {
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
