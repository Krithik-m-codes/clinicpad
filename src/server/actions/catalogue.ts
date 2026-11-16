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

export async function saveFavouriteAction(line: unknown): Promise<CatalogueActionResult<FavouriteView>> {
  const session = await getSessionContext();
  if (!session) return SIGNED_OUT;
  return saveFavourite(session, line);
}

export async function removeFavouriteAction(id: string): Promise<CatalogueActionResult<null>> {
  const session = await getSessionContext();
  if (!session) return SIGNED_OUT;
  return removeFavourite(session, String(id));
}

export async function addClinicMedicineAction(
  raw: unknown,
): Promise<CatalogueActionResult<{ id: string; created: boolean }>> {
  const session = await getSessionContext();
  if (!session) return SIGNED_OUT;
  return addClinicMedicine(session, raw);
}
