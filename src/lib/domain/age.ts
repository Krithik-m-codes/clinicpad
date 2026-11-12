/** "6 y", "15 mo" or "11 d". Empty string for a missing, malformed, or future date of birth. */
export function ageLabel(dob: string, now: Date): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dob);
  if (!m) return "";
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const born = Date.UTC(y, mo - 1, d);
  if (Number.isNaN(born) || new Date(born).getUTCMonth() !== mo - 1) return "";

  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  if (born > today) return "";

  let months = (now.getUTCFullYear() - y) * 12 + (now.getUTCMonth() - (mo - 1));
  if (now.getUTCDate() < d) months -= 1;

  if (months >= 24) return `${Math.floor(months / 12)} y`;
  if (months >= 1) return `${months} mo`;
  return `${Math.round((today - born) / 86_400_000)} d`;
}
