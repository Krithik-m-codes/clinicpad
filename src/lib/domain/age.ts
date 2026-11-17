/**
 * "6 y", "15 mo" or "11 d". Empty string for a missing, malformed, or future date of birth.
 * `now` is an instant (aged on its UTC day) or, to age on another calendar, today's "YYYY-MM-DD".
 */
export function ageLabel(dob: string, now: Date | string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dob);
  if (!m) return "";
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const born = Date.UTC(y, mo - 1, d);
  if (Number.isNaN(born) || new Date(born).getUTCMonth() !== mo - 1) return "";

  let ty: number;
  let tmo: number;
  let td: number;
  if (typeof now === "string") {
    const t = /^(\d{4})-(\d{2})-(\d{2})$/.exec(now);
    if (!t) return "";
    ty = Number(t[1]);
    tmo = Number(t[2]) - 1;
    td = Number(t[3]);
    if (new Date(Date.UTC(ty, tmo, td)).getUTCMonth() !== tmo) return "";
  } else {
    ty = now.getUTCFullYear();
    tmo = now.getUTCMonth();
    td = now.getUTCDate();
  }
  const today = Date.UTC(ty, tmo, td);
  if (Number.isNaN(today) || born > today) return "";

  let months = (ty - y) * 12 + (tmo - (mo - 1));
  if (td < d) months -= 1;

  if (months >= 24) return `${Math.floor(months / 12)} y`;
  if (months >= 1) return `${months} mo`;
  return `${Math.round((today - born) / 86_400_000)} d`;
}
