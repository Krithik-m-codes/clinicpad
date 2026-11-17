import { z } from "zod";
import { cleanText } from "@/lib/domain/text";

/** Postgres text cannot hold a NUL byte (it raises an encoding error), so refuse it at the boundary. */
export const hasNoNul = (value: string) => !value.includes("\u0000");
export const NUL_MESSAGE = "Text contains an invalid character";

export const blankToUndefined = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;


/**
 * Plan 1B text cleaning before validation: NFC, CR/CRLF to LF, stray control characters removed
 * (cleanText). A string that contains a NUL is passed through untouched so `hasNoNul` refuses it:
 * a NUL is reported to the user, never silently removed.
 */
export const cleanInput = (value: unknown) =>
  typeof value === "string" && hasNoNul(value) ? cleanText(value) : value;

/** Cleaned (cleanInput), trimmed, length-limited text without NUL characters; blank means absent. */
export const optionalText = (max: number) =>
  z.preprocess((value) => blankToUndefined(cleanInput(value)), z.string().trim().max(max).refine(hasNoNul, NUL_MESSAGE).optional());

/** Cleaned, trimmed, length-limited text without NUL; blank (after cleaning) means absent. */
export const cleanOptionalText = (max: number) =>
  z.preprocess(
    (value) => blankToUndefined(cleanInput(value)),
    z.string().trim().max(max, `Keep this to at most ${max} characters`).refine(hasNoNul, NUL_MESSAGE).optional(),
  );

/** Cleaned, trimmed, length-limited, non-empty text without NUL. */
export const cleanRequiredText = (max: number, message: string) =>
  z.preprocess(
    cleanInput,
    z.string().trim().min(1, message).max(max, `Keep this to at most ${max} characters`).refine(hasNoNul, NUL_MESSAGE),
  );
