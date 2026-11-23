"use client";

import { useEffect, useState } from "react";
import type { TermKind } from "@/lib/domain/rx-options";
import type { MedicineHit } from "@/server/services/catalogue";

export type SearchKind = "medicine" | TermKind;

type SearchState = { medicines: MedicineHit[]; terms: string[]; loading: boolean; failed: boolean };
const EMPTY: SearchState = { medicines: [], terms: [], loading: false, failed: false };

/** A finished search, tagged with the query it answered so it can never be shown for another one. */
type Answer = { key: string; medicines: MedicineHit[]; terms: string[]; failed: boolean };

/**
 * Debounced typeahead against GET /api/catalogue/search. Each new query aborts the previous
 * request, so a slow response can never overwrite a newer one. An empty medicine query
 * returns the user's favourites; an empty term query is never searched.
 *
 * Results are only returned for the query currently typed: from the moment it changes (and
 * whenever `active` is false) the hook returns no hits, and `loading` is true until the answer
 * for the current query arrives.
 */
export function useCatalogueSearch(kind: SearchKind, query: string, active: boolean, delayMs = 200): SearchState {
  const [answer, setAnswer] = useState<Answer | null>(null);
  const q = query.trim();
  const searchable = active && (kind === "medicine" || q !== "");
  const key = `${kind}\u0000${q}`;

  useEffect(() => {
    if (!searchable) {
      setAnswer(null);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/catalogue/search?kind=${kind}&q=${encodeURIComponent(q)}`, {
          signal: controller.signal,
          cache: "no-store",
        });
        if (!res.ok) throw new Error(`search failed: ${res.status}`);
        const body = (await res.json()) as { medicines?: MedicineHit[]; terms?: string[] };
        if (!controller.signal.aborted) {
          setAnswer({ key, medicines: body.medicines ?? [], terms: body.terms ?? [], failed: false });
        }
      } catch {
        if (!controller.signal.aborted) setAnswer({ key, medicines: [], terms: [], failed: true });
      }
    }, delayMs);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [kind, q, key, searchable, delayMs]);

  if (!searchable) return EMPTY;
  if (answer === null || answer.key !== key) return { ...EMPTY, loading: true };
  return { medicines: answer.medicines, terms: answer.terms, loading: false, failed: answer.failed };
}
