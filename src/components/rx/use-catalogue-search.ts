"use client";

import { useEffect, useState } from "react";
import type { TermKind } from "@/lib/domain/rx-options";
import type { MedicineHit } from "@/server/services/catalogue";

export type SearchKind = "medicine" | TermKind;

type SearchState = { medicines: MedicineHit[]; terms: string[]; loading: boolean; failed: boolean };
const EMPTY: SearchState = { medicines: [], terms: [], loading: false, failed: false };

/**
 * Debounced typeahead against GET /api/catalogue/search. Each new query aborts the previous
 * request, so a slow response can never overwrite a newer one. An empty medicine query
 * returns the user's favourites; an empty term query returns nothing.
 */
export function useCatalogueSearch(kind: SearchKind, query: string, active: boolean, delayMs = 200): SearchState {
  const [state, setState] = useState<SearchState>(EMPTY);

  useEffect(() => {
    if (!active) return;
    const q = query.trim();
    if (kind !== "medicine" && q === "") {
      setState(EMPTY);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setState((s) => ({ ...s, loading: true, failed: false }));
      try {
        const res = await fetch(`/api/catalogue/search?kind=${kind}&q=${encodeURIComponent(q)}`, {
          signal: controller.signal,
          cache: "no-store",
        });
        if (!res.ok) throw new Error(`search failed: ${res.status}`);
        const body = (await res.json()) as { medicines?: MedicineHit[]; terms?: string[] };
        if (!controller.signal.aborted) {
          setState({ medicines: body.medicines ?? [], terms: body.terms ?? [], loading: false, failed: false });
        }
      } catch {
        if (!controller.signal.aborted) setState({ ...EMPTY, failed: true });
      }
    }, delayMs);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [kind, query, active, delayMs]);

  return state;
}
