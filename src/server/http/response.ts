import type { ErrorCode } from "@/lib/result";

/** HTTP status for a service error. Forbidden is a 404: a role that cannot read must not learn that an id exists. */
export function statusForError(code: ErrorCode): number {
  switch (code) {
    case "forbidden":
    case "not_found":
      return 404;
    case "conflict":
    case "immutable":
      return 409;
    case "invalid":
      return 422;
    case "unavailable":
      return 503;
    case "timeout":
      return 504;
  }
}

export const NOT_FOUND_MESSAGE = "Prescription not found.";

/** The message to show: forbidden reads exactly like not found. */
export function publicMessage(code: ErrorCode, message: string): string {
  return code === "forbidden" ? NOT_FOUND_MESSAGE : message;
}

/** The error code to show: forbidden reads exactly like not found. */
export function publicCode(code: ErrorCode): ErrorCode {
  return code === "forbidden" ? "not_found" : code;
}

function rfc5987(value: string): string {
  return encodeURIComponent(value).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** Control characters (CR and LF included) and the Unicode line and paragraph separators. */
function isControl(code: number): boolean {
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029;
}

/**
 * A Content-Disposition value that cannot be used to inject a header or a parameter: control
 * characters, quotes, backslashes, path separators and semicolons are dropped; a non-ASCII name
 * gets an ASCII fallback plus an RFC 5987 `filename*`.
 */
export function contentDisposition(type: "inline" | "attachment", fileName: string): string {
  const clean = Array.from(fileName)
    .filter((ch) => !isControl(ch.codePointAt(0) ?? 0) && !'"\\/;'.includes(ch))
    .join("")
    .trim();
  const name = clean === "" ? "document" : clean;
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/%/g, "_");
  return ascii === name ? `${type}; filename="${name}"` : `${type}; filename="${ascii}"; filename*=UTF-8''${rfc5987(name)}`;
}
