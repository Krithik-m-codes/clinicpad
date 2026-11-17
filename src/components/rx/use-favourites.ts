"use client";

import { useRef, useState } from "react";
import { toItemPayload, type EditorMedicine } from "@/lib/rx/editor-state";
import { addClinicMedicineAction, removeFavouriteAction, saveFavouriteAction } from "@/server/actions/catalogue";
import type { FavouriteView } from "@/server/services/catalogue";

const NO_CONNECTION = "Could not reach the server. Check your connection and try again.";
const REMOVE_FAILED = "Could not remove the favourite. Try again.";

/** The doctor's favourites plus the clinic-list action; each returns a short message for the screen. */
export function useFavourites(initial: FavouriteView[]) {
  const [favourites, setFavourites] = useState<FavouriteView[]>(initial);
  const [removeNote, setRemoveNote] = useState("");
  // A ref closes the gap before a re-render, so a fast double click sends one request.
  const removing = useRef(new Set<string>());

  async function saveFavourite(m: EditorMedicine): Promise<string> {
    try {
      const res = await saveFavouriteAction(toItemPayload(m));
      if (!res.ok) return res.message;
      const saved = res.value;
      setFavourites((list) =>
        [...list.filter((f) => f.id !== saved.id), saved].sort((a, b) => a.drugName.localeCompare(b.drugName)),
      );
      return "Saved as favourite";
    } catch {
      return NO_CONNECTION;
    }
  }

  async function removeFavourite(f: FavouriteView): Promise<void> {
    if (removing.current.has(f.id)) return;
    removing.current.add(f.id);
    setRemoveNote("");
    try {
      const res = await removeFavouriteAction(f.id);
      if (res.ok) setFavourites((list) => list.filter((x) => x.id !== f.id));
      else setRemoveNote(REMOVE_FAILED);
    } catch {
      setRemoveNote(REMOVE_FAILED); // nothing changed on the server, so the favourite stays listed
    } finally {
      removing.current.delete(f.id);
    }
  }

  async function addToClinic(name: string, genericName: string): Promise<string> {
    try {
      const res = await addClinicMedicineAction({ name, genericName });
      if (!res.ok) return res.message;
      return res.value.created ? "Added to the clinic list" : "Already in the clinic list";
    } catch {
      return NO_CONNECTION;
    }
  }

  return { favourites, removeNote, saveFavourite, removeFavourite, addToClinic };
}
