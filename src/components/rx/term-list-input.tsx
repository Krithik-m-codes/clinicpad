"use client";

import { useId, useState, type KeyboardEvent } from "react";
import { X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useCatalogueSearch, type SearchKind } from "./use-catalogue-search";

type Props = {
  label: string;
  kind: SearchKind;
  values: string[];
  onChange: (values: string[]) => void;
  max: number;
  placeholder?: string;
};

/** A list of short phrases (complaints, diagnoses, history...) with suggestions and free text. */
export function TermListInput({ label, kind, values, onChange, max, placeholder }: Props) {
  const inputId = useId();
  const listId = useId();
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const { medicines, terms } = useCatalogueSearch(kind, text, open && text.trim() !== "");
  const full = values.length >= max;
  const suggestions = (kind === "medicine" ? medicines.map((m) => m.name) : terms)
    .filter((s) => !values.some((v) => v.toLowerCase() === s.toLowerCase()))
    .slice(0, 10);

  function add(raw: string) {
    const phrase = raw.replace(/\s+/g, " ").trim().slice(0, 200);
    setText("");
    setActive(-1);
    if (!phrase || full || values.some((v) => v.toLowerCase() === phrase.toLowerCase())) return;
    onChange([...values, phrase]);
  }

  function remove(index: number) {
    onChange(values.filter((_, i) => i !== index));
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setActive((i) => Math.min(i + 1, suggestions.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, -1));
    } else if ((e.key === "Enter" || e.key === ",") && text.trim() !== "") {
      e.preventDefault();
      add(active >= 0 && suggestions[active] ? suggestions[active] : text);
    } else if (e.key === "Backspace" && text === "" && values.length > 0) {
      remove(values.length - 1);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  const showList = open && suggestions.length > 0;

  return (
    <div className="space-y-1">
      <label htmlFor={inputId} className="text-sm font-medium">
        {label}
      </label>
      <div className="relative">
        <div className="flex flex-wrap items-center gap-1 rounded-md border-2 border-gray-200 bg-white p-1">
          {values.map((value, index) => (
            <Badge key={`${value}-${index}`} variant="secondary" className="gap-1 px-2 py-0.5 text-xs">
              {value}
              <button
                type="button"
                aria-label={`Remove ${value}`}
                className="rounded hover:bg-gray-300"
                onClick={() => remove(index)}
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ))}
          <input
            id={inputId}
            role="combobox"
            aria-expanded={showList}
            aria-controls={listId}
            aria-autocomplete="list"
            className="min-w-[8rem] flex-1 bg-transparent px-2 py-1 text-sm outline-none disabled:cursor-not-allowed"
            placeholder={full ? `Limit of ${max} reached` : (placeholder ?? "Type and press Enter")}
            disabled={full}
            maxLength={200}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setOpen(true);
              setActive(-1);
            }}
            onFocus={() => setOpen(true)}
            onBlur={() => {
              // A phrase typed but not confirmed is kept, never silently lost.
              if (text.trim() !== "") add(text);
              setOpen(false);
            }}
            onKeyDown={onKeyDown}
          />
        </div>
        {showList ? (
          // The name must not contain the field label: getByLabel(label) in the e2e specs would match it.
          <ul
            id={listId}
            role="listbox"
            aria-label="Phrase suggestions"
            className="absolute z-50 mt-1 max-h-56 w-full overflow-auto rounded-md border bg-white text-sm shadow-lg"
          >
            {suggestions.map((suggestion, index) => (
              <li
                key={suggestion}
                role="option"
                aria-selected={index === active}
                className={`cursor-pointer px-3 py-2 ${index === active ? "bg-muted" : "hover:bg-muted"}`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => add(suggestion)}
              >
                {suggestion}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}
