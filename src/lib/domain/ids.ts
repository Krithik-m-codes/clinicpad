import { uuidv7 } from "uuidv7";
import { z } from "zod";

export function newId(): string {
  return uuidv7();
}

const uuidSchema = z.uuid();

/** Guard before passing a client-supplied id to a uuid column (a bad string is a 500 otherwise). */
export function isUuid(value: string): boolean {
  return uuidSchema.safeParse(value).success;
}
