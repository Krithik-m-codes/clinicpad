"use client";

import { useId, useRef, useState, type ClipboardEvent, type KeyboardEvent } from "react";
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

const MAX_PHRASE = 200;
const DELIMITERS = /[,\r\n]+/;

const cleanPhrase = (raw: string) => raw.replace(/\s+/g, " ").trim().slice(0, MAX_PHRASE);

/** A list of short phrases (complaints, diagnoses, history...) with suggestions and free text. */
export function TermListInput({ label, kind, values, onChange, max, placeholder }: Props) {
  const inputId = useId();
  const listId = useId();
  const composing = useRef(false);
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const hasText = text.trim() !== "";
  const { medicines, terms } = useCatalogueSearch(kind, text, open && hasText);
  const full = values.length >= max;
  const suggestions = (kind === "medicine" ? medicines.map((m) => m.name) : terms)
    .filter((s) => !values.some((v) => v.toLowerCase() === s.toLowerCase()))
    .slice(0, 10);
  const showList = open && hasText && suggestions.length > 0;
  const activeIndex = active < suggestions.length ? active : -1;

  /** Adds phrases in order, skipping blanks and repeats (any case), up to the limit. One change event. */
  function addAll(raws: string[]) {
    setText("");
    setActive(-1);
    setOpen(false);
    const next = [...values];
    for (const raw of raws) {
      const phrase = cleanPhrase(raw);
      if (!phrase || next.length >= max || next.some((v) => v.toLowerCase() === phrase.toLowerCase())) continue;
      next.push(phrase);
    }
    if (next.length !== values.length) onChange(next);
  }

  function remove(index: number) {
    onChange(values.filter((_, i) => i !== index));
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    // Keys pressed while an IME is composing belong to the IME. 229 is what Safari and older browsers report.
    if (composing.current || e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setActive(Math.min(activeIndex + 1, suggestions.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive(Math.max(activeIndex - 1, -1));
    } else if (e.key === "Enter") {
      // Never submit the surrounding form from here, even with nothing to add.
      e.preventDefault();
      if (hasText) addAll([showList && activeIndex >= 0 ? suggestions[activeIndex] : text]);
    } else if (e.key === ",") {
      e.preventDefault();
      if (hasText) addAll([text]);
    } else if (e.key === "Backspace" && text === "" && values.length > 0) {
      remove(values.length - 1);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  function onPaste(e: ClipboardEvent<HTMLInputElement>) {
    const pasted = e.clipboardData.getData("text");
    if (!DELIMITERS.test(pasted)) return;
    e.preventDefault();
    // Anything already typed is kept as its own phrase, as it would be on blur.
    addAll([text, ...pasted.split(DELIMITERS)]);
  }

  return (
    <div className="space-y-1">
      <label htmlFor={inputId} className="text-sm font-medium">
        {label}
      </label>
      <div className="relative">
        <div className="flex flex-wrap items-center gap-1 rounded-md border-2 border-gray-200 bg-white p-1">
          {values.map((value, index) => (
            <Badge
              key={`${value}-${index}`}
              variant="secondary"
              className="min-w-0 max-w-full items-start gap-1 whitespace-normal rounded-md px-2 py-0.5 text-xs"
            >
              <span dir="auto" className="min-w-0 break-words text-left">
                {value}
              </span>
              <button
                type="button"
                aria-label={`Remove ${value}`}
                className="shrink-0 rounded hover:bg-gray-300"
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
            aria-controls={showList ? listId : undefined}
            aria-activedescendant={showList && activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined}
            aria-autocomplete="list"
            className="min-w-[8rem] flex-1 bg-transparent px-2 py-1 text-sm outline-none disabled:cursor-not-allowed"
            placeholder={full ? `Limit of ${max} reached` : (placeholder ?? "Type and press Enter")}
            disabled={full}
            maxLength={MAX_PHRASE}
            value={text}
            onChange={(e) => {
              const next = e.target.value;
              // A comma that arrives as plain input (mobile keyboards, some IMEs) ends the phrase too.
              if (!composing.current && DELIMITERS.test(next)) {
                addAll(next.split(DELIMITERS));
                return;
              }
              setText(next);
              setOpen(true);
              setActive(-1);
            }}
            onCompositionStart={() => {
              composing.current = true;
            }}
            onCompositionEnd={() => {
              composing.current = false;
            }}
            onFocus={() => setOpen(true)}
            onBlur={() => {
              // A phrase typed but not confirmed is kept, never silently lost.
              if (hasText) addAll([text]);
              setOpen(false);
            }}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
          />
        </div>
        {showList ? (
          // The name must not contain the field label: getByLabel(label) in the e2e specs would match it.
          // Pressing the list (an option, the scrollbar) must not blur the input, or the list would close before the click lands.
          <ul
            id={listId}
            role="listbox"
            aria-label="Phrase suggestions"
            className="absolute z-50 mt-1 max-h-56 w-full min-w-0 overflow-auto rounded-md border bg-white text-sm shadow-lg"
            onMouseDown={(e) => e.preventDefault()}
          >
            {suggestions.map((suggestion, index) => (
              <li
                key={suggestion}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={index === activeIndex}
                className={`cursor-pointer break-words px-3 py-2 ${index === activeIndex ? "bg-muted" : "hover:bg-muted"}`}
                onClick={() => addAll([suggestion])}
              >
                <span dir="auto" className="break-words">
                  {suggestion}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}
