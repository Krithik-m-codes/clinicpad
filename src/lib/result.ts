import type { ZodError } from "zod";

export type ErrorCode = "forbidden" | "not_found" | "invalid" | "conflict" | "immutable";

export type Ok<T> = { ok: true; value: T };
export type ServiceError = { ok: false; code: ErrorCode; message: string; field?: string };
export type Result<T> = Ok<T> | ServiceError;

export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

export function fail(code: ErrorCode, message: string, field?: string): ServiceError {
  return field ? { ok: false, code, message, field } : { ok: false, code, message };
}

/** First Zod issue as a field-level error. */
export function invalidFrom(error: ZodError): ServiceError {
  const issue = error.issues[0];
  const field = issue.path.length > 0 ? String(issue.path[0]) : undefined;
  return fail("invalid", issue.message, field);
}
