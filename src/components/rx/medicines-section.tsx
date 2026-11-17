"use client";

import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { RX_LIMITS } from "@/lib/domain/rx-options";
import type { EditorMedicine } from "@/lib/rx/editor-state";
import type { FavouriteView, MedicineHit } from "@/server/services/catalogue";
import { MedicineRow } from "./medicine-row";

type Props = {
  medicines: EditorMedicine[];
  favourites: FavouriteView[];
  canAddToClinic: boolean;
  onPatch: (key: string, patch: Partial<EditorMedicine>) => void;
  onPick: (key: string, hit: MedicineHit) => void;
  onAdd: () => void;
  onAddFavourite: (favourite: FavouriteView) => void;
  onRemove: (key: string) => void;
  onSaveFavourite: (medicine: EditorMedicine) => Promise<string>;
  onRemoveFavourite: (favourite: FavouriteView) => Promise<void>;
  onAddToClinic: (name: string, genericName: string) => Promise<string>;
};

export function MedicinesSection(props: Props) {
  const { medicines, favourites } = props;
  const full = medicines.length >= RX_LIMITS.medicines;
  return (
    <section className="space-y-3" aria-labelledby="medicines-heading">
      <div className="flex items-baseline justify-between">
        <h2 id="medicines-heading" className="font-medium">
          Medicines
        </h2>
        <span className="text-xs text-muted-foreground">
          {medicines.length} of {RX_LIMITS.medicines}
        </span>
      </div>

      {favourites.length > 0 ? (
        <div role="group" aria-label="Favourites" className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">Favourites:</span>
          {favourites.map((f) => (
            <span key={f.id} className="inline-flex items-center rounded-full border bg-white text-xs">
              <button
                type="button"
                className="px-2 py-1 hover:underline disabled:opacity-50"
                disabled={full}
                aria-label={`Add favourite ${f.drugName}`}
                onClick={() => props.onAddFavourite(f)}
              >
                ★ {f.drugName}
              </button>
              <button
                type="button"
                className="rounded-full px-1 py-1 hover:bg-muted"
                aria-label={`Remove favourite ${f.drugName}`}
                onClick={() => void props.onRemoveFavourite(f)}
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      ) : null}

      {medicines.map((m, index) => (
        <MedicineRow
          key={m.key}
          index={index}
          medicine={m}
          canAddToClinic={props.canAddToClinic}
          onPatch={(patch) => props.onPatch(m.key, patch)}
          onPick={(hit) => props.onPick(m.key, hit)}
          onRemove={() => props.onRemove(m.key)}
          onSaveFavourite={() => props.onSaveFavourite(m)}
          onAddToClinic={(name) => props.onAddToClinic(name, m.genericName)}
        />
      ))}

      <Button type="button" variant="outline" disabled={full} onClick={props.onAdd}>
        Add medicine
      </Button>
    </section>
  );
}
