import { z } from "zod";

/** Postgres text cannot hold a NUL byte (it raises an encoding error), so refuse it at the boundary. */
export const hasNoNul = (value: string) => !value.includes("\u0000");
export const NUL_MESSAGE = "Text contains an invalid character";

export const blankToUndefined = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

/** Trimmed, length-limited text without NUL characters; blank means absent. */
export const optionalText = (max: number) =>
  z.preprocess(blankToUndefined, z.string().trim().max(max).refine(hasNoNul, NUL_MESSAGE).optional());
