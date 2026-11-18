"use client";

import { Textarea } from "@/components/ui/textarea";
import { RX_LIMITS } from "@/lib/domain/rx-options";
import type { EditorState } from "@/lib/rx/editor-state";
import { TermListInput } from "./term-list-input";
import type { SearchKind } from "./use-catalogue-search";

export type PhraseListKey = "complaints" | "diagnosis" | "medicalHistory" | "drugHistory";

const LISTS: { key: PhraseListKey; label: string; kind: SearchKind; max: number }[] = [
  { key: "complaints", label: "Complaints", kind: "complaint", max: RX_LIMITS.phrases },
  { key: "diagnosis", label: "Diagnosis", kind: "diagnosis", max: RX_LIMITS.diagnoses },
  { key: "medicalHistory", label: "Medical history", kind: "history", max: RX_LIMITS.phrases },
  { key: "drugHistory", label: "Drug history", kind: "medicine", max: RX_LIMITS.phrases },
];

type Props = {
  state: Pick<EditorState, PhraseListKey | "examinationNotes">;
  onListChange: (key: PhraseListKey, values: string[]) => void;
  onNotesChange: (value: string) => void;
};

export function ClinicalNotesSection({ state, onListChange, onNotesChange }: Props) {
  return (
    <section className="space-y-4" aria-labelledby="clinical-heading">
      <h2 id="clinical-heading" className="font-medium">
        History and findings
      </h2>
      <div className="grid gap-4 sm:grid-cols-2">
        {LISTS.map((list) => (
          <TermListInput
            key={list.key}
            label={list.label}
            kind={list.kind}
            max={list.max}
            values={state[list.key]}
            onChange={(values) => onListChange(list.key, values)}
          />
        ))}
      </div>
      <div className="space-y-1">
        <label htmlFor="examinationNotes" className="text-sm font-medium">
          Examination notes
        </label>
        <Textarea
          id="examinationNotes"
          rows={3}
          className="min-h-[80px]"
          maxLength={2000}
          value={state.examinationNotes}
          onChange={(e) => onNotesChange(e.target.value)}
        />
      </div>
    </section>
  );
}
