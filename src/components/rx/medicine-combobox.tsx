"use client";

import { useId, useState, type KeyboardEvent } from "react";
import { Input } from "@/components/ui/input";
import { catalogueKey } from "@/lib/domain/search";
import type { MedicineHit } from "@/server/services/catalogue";
import { useCatalogueSearch } from "./use-catalogue-search";

type Props = {
  value: string;
  onTextChange: (value: string) => void;
  onPick: (hit: MedicineHit) => void;
  onAddToClinic?: (name: string) => void;
};

type Option = { kind: "hit"; hit: MedicineHit } | { kind: "add"; name: string };

const SOURCE_LABEL: Record<MedicineHit["source"], string> = { favourite: "★ Favourite", clinic: "Clinic list", global: "" };

/** Medicine name with catalogue suggestions. Free text is always allowed. */
export function MedicineCombobox({ value, onTextChange, onPick, onAddToClinic }: Props) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const { medicines, loading, failed } = useCatalogueSearch("medicine", value, open);

  const typed = value.trim();
  const exact = medicines.some((m) => catalogueKey(m.name) === catalogueKey(typed));
  const options: Option[] = [
    ...medicines.map((hit) => ({ kind: "hit" as const, hit })),
    ...(onAddToClinic && typed.length >= 2 && !exact && !loading ? [{ kind: "add" as const, name: typed }] : []),
  ];

  function choose(option: Option) {
    setOpen(false);
    setActive(-1);
    if (option.kind === "hit") onPick(option.hit);
    else onAddToClinic?.(option.name);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setActive((i) => Math.min(i + 1, options.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, -1));
    } else if (e.key === "Enter" && open && active >= 0 && options[active]) {
      e.preventDefault();
      choose(options[active]);
    } else if (e.key === "Escape") {
      setOpen(false);
      setActive(-1);
    }
  }

  const showList = open && (options.length > 0 || loading || failed);

  return (
    <div className="relative">
      <Input
        role="combobox"
        aria-label="Medicine name"
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
        autoComplete="off"
        placeholder="Type a medicine name"
        maxLength={200}
        value={value}
        onChange={(e) => {
          onTextChange(e.target.value);
          setOpen(true);
          setActive(-1);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
      />
      {showList ? (
        <div className="absolute z-50 mt-1 w-full rounded-md border bg-white text-sm shadow-lg">
          {loading && options.length === 0 ? <p className="px-3 py-2 text-muted-foreground">Searching…</p> : null}
          {failed ? <p className="px-3 py-2 text-muted-foreground">Search is unavailable. Type the full name.</p> : null}
          <ul id={listId} role="listbox" aria-label="Medicine suggestions" className="max-h-64 overflow-auto">
            {options.map((option, index) => (
              <li
                key={option.kind === "hit" ? `${option.hit.source}-${option.hit.id}` : "add"}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={index === active}
                className={`cursor-pointer px-3 py-2 ${index === active ? "bg-muted" : "hover:bg-muted"}`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(option)}
              >
                {option.kind === "hit" ? (
                  <>
                    <span className="font-medium">{option.hit.name}</span>
                    {SOURCE_LABEL[option.hit.source] ? (
                      <span className="ml-2 text-xs text-muted-foreground">{SOURCE_LABEL[option.hit.source]}</span>
                    ) : null}
                    {option.hit.genericName ? (
                      <span className="block text-xs text-muted-foreground">{option.hit.genericName}</span>
                    ) : null}
                  </>
                ) : (
                  <span>Add “{option.name}” to the clinic list</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
