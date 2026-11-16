"use server";

import { getSessionContext } from "@/server/auth/session";
import {
  addClinicMedicine,
  removeFavourite,
  saveFavourite,
  type FavouriteView,
} from "@/server/services/catalogue";

export type CatalogueActionResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: string; message: string; field?: string };

const SIGNED_OUT = {
  ok: false as const,
  code: "unauthenticated",
  message: "You were signed out. Sign in again, then retry.",
};
const INTERNAL = {
  ok: false as const,
  code: "internal",
  message: "Something went wrong. Please try again.",
};

/** Runs one action as the signed-in user; never redirects and never rejects. */
async function asSession<T>(
  name: string,
  run: (session: NonNullable<Awaited<ReturnType<typeof getSessionContext>>>) => Promise<CatalogueActionResult<T>>,
): Promise<CatalogueActionResult<T>> {
  try {
    const session = await getSessionContext();
    if (!session) return SIGNED_OUT;
    return await run(session);
  } catch (error) {
    // Error class only: exception messages can carry row values.
    console.error(`${name} failed`, error instanceof Error ? error.name : typeof error);
    return INTERNAL;
  }
}

export async function saveFavouriteAction(line: unknown): Promise<CatalogueActionResult<FavouriteView>> {
  return asSession("saveFavouriteAction", (session) => saveFavourite(session, line));
}

export async function removeFavouriteAction(id: string): Promise<CatalogueActionResult<null>> {
  return asSession("removeFavouriteAction", (session) => removeFavourite(session, String(id)));
}

export async function addClinicMedicineAction(
  raw: unknown,
): Promise<CatalogueActionResult<{ id: string; created: boolean }>> {
  return asSession("addClinicMedicineAction", (session) => addClinicMedicine(session, raw));
}
