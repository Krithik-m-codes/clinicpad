"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RX_LIMITS } from "@/lib/domain/rx-options";
import type { EditorInvestigation } from "@/lib/rx/editor-state";
import { TermListInput } from "./term-list-input";

type Props = {
  items: EditorInvestigation[];
  onAdd: (name: string) => void;
  onPatch: (key: string, patch: Partial<EditorInvestigation>) => void;
  onRemove: (key: string) => void;
};

export function InvestigationsSection({ items, onAdd, onPatch, onRemove }: Props) {
  return (
    <section className="space-y-3" aria-labelledby="tests-heading">
      <h2 id="tests-heading" className="font-medium">
        Investigations
      </h2>
      {/* The phrase input is used only as an adder: each confirmed name becomes a row below. */}
      <TermListInput
        label="Add test"
        kind="test"
        values={[]}
        max={RX_LIMITS.investigations - items.length}
        placeholder="Type a test and press Enter"
        onChange={(values) => values.forEach(onAdd)}
      />
      {items.length > 0 ? (
        <ul className="space-y-2">
          {items.map((test) => (
            <li key={test.key} className="grid gap-2 sm:grid-cols-[1fr_2fr_auto]">
              <Input
                aria-label="Test name"
                className="h-9"
                maxLength={120}
                value={test.name}
                onChange={(e) => onPatch(test.key, { name: e.target.value })}
              />
              <Input
                aria-label="Test instructions"
                className="h-9"
                maxLength={300}
                placeholder="Instructions (optional)"
                value={test.instructions}
                onChange={(e) => onPatch(test.key, { instructions: e.target.value })}
              />
              <Button type="button" size="sm" variant="ghost" onClick={() => onRemove(test.key)}>
                Remove test
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
