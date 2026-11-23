export type ShareMessageParts = { clinicName: string; rxNo: number; version: number; url: string; expiresOn: string };

const MAX_CLINIC = 80;

/**
 * The WhatsApp text: clinic, Rx number, link, expiry. Never the patient's name or clinical text — WhatsApp shows
 * messages in notifications and people forward them (decision 9).
 */
export function shareMessageText(p: ShareMessageParts): string {
  const clinic = p.clinicName.replace(/\s+/g, " ").trim().slice(0, MAX_CLINIC) || "Your clinic";
  const label = `Rx ${p.rxNo}${p.version > 1 ? ` v${p.version}` : ""}`;
  return `${clinic}: your prescription ${label} is ready. Open it here (the link works until ${p.expiresOn}): ${p.url}`;
}

/**
 * The universal link (not whatsapp://): on a phone it opens the app, on a desktop the WhatsApp Desktop or Web
 * prompt, with the text filled in. The clinic presses send; ClinicPad sends nothing itself.
 */
export function waMeLink(digits: string, text: string): string {
  if (!/^\d{8,15}$/.test(digits)) throw new Error("waMeLink needs 8 to 15 digits");
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}
