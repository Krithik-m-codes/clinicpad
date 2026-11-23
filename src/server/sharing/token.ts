import { createHash, randomBytes } from "node:crypto";

/** 32 random bytes in base64url without padding. */
export const SHARE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function newShareToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Checked before any lookup, so malformed input never reaches the database. */
export function isShareToken(value: unknown): value is string {
  return typeof value === "string" && SHARE_TOKEN_PATTERN.test(value);
}

/** Only this digest is stored (share_links.token_hash); the token itself exists only in the URL. */
export function shareTokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}
