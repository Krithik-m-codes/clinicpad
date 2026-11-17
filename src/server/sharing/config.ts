const DEV_URL = "http://localhost:3000";

/**
 * The public base URL for share links, from NEXT_PUBLIC_APP_URL (never from request headers, which a client can
 * forge). An origin only (no path); https in production. Missing in production means sharing is unavailable.
 */
export function resolveAppUrl(env: { NODE_ENV?: string; NEXT_PUBLIC_APP_URL?: string }): string | null {
  const raw = (env.NEXT_PUBLIC_APP_URL ?? "").trim();
  if (raw === "") return env.NODE_ENV === "production" ? null : DEV_URL;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (env.NODE_ENV === "production" && url.protocol !== "https:") return null;
    if (url.pathname !== "/" || url.search !== "" || url.hash !== "") return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function shareUrl(token: string, baseUrl: string): string {
  return `${baseUrl}/s/${token}`;
}
