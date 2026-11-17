"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RX_LIMITS } from "@/lib/domain/rx-options";
import {
  applyHit,
  editorStateFromView,
  emptyMedicine,
  isBlankMedicine,
  medicineFrom,
  newKey,
  type EditorInvestigation,
  type EditorMedicine,
  type EditorState,
} from "@/lib/rx/editor-state";
import type { FavouriteView } from "@/server/services/catalogue";
import type { ClinicalVisitView, ItemView } from "@/server/services/rx-mapping";
import { AdviceSection } from "./advice-section";
import type { AutosaveStatus } from "@/lib/rx/autosave";
import { AutosaveStatusBar } from "./autosave-status";
import { ClinicalNotesSection } from "./clinical-notes-section";
import { InvestigationsSection } from "./investigations-section";
import { MedicinesSection } from "./medicines-section";
import { COULD_NOT_CONFIRM_MESSAGE, isUnknownOutcome, useAutosave } from "./use-autosave";
import { useFavourites } from "./use-favourites";
import { VitalsSection } from "./vitals-section";

const selectClass = "flex h-11 w-full rounded-md border-2 border-gray-200 bg-white px-3 text-sm";

type Props = {
  prescriptionId: string;
  visit: ClinicalVisitView;
  items: ItemView[];
  revision: number;
  favourites: FavouriteView[];
  canAddToClinic: boolean;
  /** can(role, "rx.finalize"); editing itself is gated by the page on rx.draft. */
  canFinalize: boolean;
};

export function ClinicalEditor({
  prescriptionId,
  visit,
  items,
  revision,
  favourites: initialFavourites,
  canAddToClinic,
  canFinalize,
}: Props) {
  const router = useRouter();
  const [state, setState] = useState<EditorState>(() => editorStateFromView({ visit, items }));
  const initialState = useRef(state);
  const fav = useFavourites(initialFavourites);
  const [finalizing, setFinalizing] = useState(false);
  // Set after a successful finalize and never reset: the page is about to become the read-only view.
  const [finalized, setFinalized] = useState(false);
  const [finalizeError, setFinalizeError] = useState<string | null>(null);
  const autosave = useAutosave(prescriptionId, initialState.current, revision);
  const { update } = autosave;

  // Every edit produces a new state object; each one reaches the autosaver exactly once.
  useEffect(() => {
    if (state !== initialState.current) {
      update(state);
      setFinalizeError(null); // the message was about the previous content
    }
  }, [state, update]);

  // A later successful save also clears it. The status that came with the failure itself is ignored.
  const errorStatus = useRef<AutosaveStatus | null>(null);
  useEffect(() => {
    if (finalizeError === null) {
      errorStatus.current = null;
    } else if (errorStatus.current === null) {
      errorStatus.current = autosave.status;
    } else if (autosave.status !== errorStatus.current && autosave.status.state === "saved") {
      setFinalizeError(null);
    }
  }, [autosave.status, finalizeError]);

  const set = <K extends keyof EditorState>(key: K, value: EditorState[K]) =>
    setState((s) => ({ ...s, [key]: value }));
  const setMedicine = (key: string, fn: (m: EditorMedicine) => EditorMedicine) =>
    setState((s) => ({ ...s, medicines: s.medicines.map((m) => (m.key === key ? fn(m) : m)) }));
  const setInvestigations = (fn: (list: EditorInvestigation[]) => EditorInvestigation[]) =>
    setState((s) => ({ ...s, investigations: fn(s.investigations) }));

  function appendMedicine(line: EditorMedicine, fillBlank: boolean) {
    setState((s) => {
      const blank = fillBlank ? s.medicines.findIndex(isBlankMedicine) : -1;
      if (blank >= 0) return { ...s, medicines: s.medicines.map((m, i) => (i === blank ? line : m)) };
      if (s.medicines.length >= RX_LIMITS.medicines) return s;
      return { ...s, medicines: [...s.medicines, line] };
    });
  }

  function removeMedicine(key: string) {
    setState((s) => {
      const rest = s.medicines.filter((m) => m.key !== key);
      return { ...s, medicines: rest.length > 0 ? rest : [emptyMedicine()] };
    });
  }

  function addInvestigation(name: string) {
    setInvestigations((list) =>
      list.length >= RX_LIMITS.investigations || list.some((t) => t.name.toLowerCase() === name.toLowerCase())
        ? list
        : [...list, { key: newKey(), name, instructions: "" }],
    );
  }

  async function finalize() {
    setFinalizing(true);
    setFinalizeError(null);
    try {
      const res = await autosave.finalize();
      if (res.ok) {
        autosave.stop(); // finalized: nothing left to save
        setFinalized(true); // stay locked until the refreshed page replaces this editor
        router.refresh(); // the page re-renders as the read-only finalized view
        return;
      }
      // A failure without a revision leaves autosave held; let it carry on.
      if (typeof res.revision !== "number") autosave.retryNow();
      if (isUnknownOutcome(res.code)) {
        // The server may have finalized before the answer was lost: re-read it. If the draft is gone
        // the page swaps this editor for the finalized view; otherwise the message stays.
        setFinalizeError(COULD_NOT_CONFIRM_MESSAGE);
        router.refresh();
        return;
      }
      setFinalizeError(res.message);
      // Already finalized (for example from another window): show the finalized view.
      if (res.code === "immutable" || (res.code === "conflict" && typeof res.currentRevision !== "number")) {
        router.refresh();
      }
    } finally {
      setFinalizing(false);
    }
  }

  const reload = () => {
    autosave.stop(); // the doctor chose the server's version: drop local edits, send nothing
    window.location.reload();
  };

  // Finalizing over a conflict, a locked draft or rejected content would fail; the status bar says why.
  const blocked = ["conflict", "locked", "invalid"].includes(autosave.status.state);

  return (
    // Disabled until the autosaver is live (after hydration): text typed into server-rendered inputs
    // before that would be wiped by React. Playwright's fill/click wait for enabled controls.
    <fieldset disabled={!autosave.ready || finalizing || finalized} className="min-w-0 space-y-8 border-0 p-0">
      <section className="grid gap-4 sm:grid-cols-3">
        <div className="space-y-1">
          <label htmlFor="visitType" className="text-sm font-medium">
            Visit type
          </label>
          <select
            id="visitType"
            className={selectClass}
            value={state.visitType}
            onChange={(e) => set("visitType", e.target.value === "follow-up" ? "follow-up" : "new")}
          >
            <option value="new">New</option>
            <option value="follow-up">Follow-up</option>
          </select>
        </div>
        <div className="space-y-1 sm:col-span-2">
          <label htmlFor="chiefComplaint" className="text-sm font-medium">
            Chief complaint
          </label>
          <Input
            id="chiefComplaint"
            maxLength={500}
            value={state.chiefComplaint}
            onChange={(e) => set("chiefComplaint", e.target.value)}
          />
        </div>
      </section>

      <VitalsSection
        vitals={state.vitals}
        notes={state.vitalsNotes}
        onChange={(key, value) => setState((s) => ({ ...s, vitals: { ...s.vitals, [key]: value } }))}
        onNotesChange={(value) => set("vitalsNotes", value)}
      />

      <ClinicalNotesSection
        state={state}
        onListChange={(key, values) => set(key, values)}
        onNotesChange={(value) => set("examinationNotes", value)}
      />

      <MedicinesSection
        medicines={state.medicines}
        favourites={fav.favourites}
        favouriteNote={fav.removeNote}
        canAddToClinic={canAddToClinic}
        onPatch={(key, patch) => setMedicine(key, (m) => ({ ...m, ...patch }))}
        onPick={(key, hit) => setMedicine(key, (m) => applyHit(m, hit))}
        onAdd={() => appendMedicine(emptyMedicine(), false)}
        onAddFavourite={(f) => appendMedicine(medicineFrom(f), true)}
        onRemove={removeMedicine}
        onSaveFavourite={fav.saveFavourite}
        onRemoveFavourite={fav.removeFavourite}
        onAddToClinic={fav.addToClinic}
      />

      <InvestigationsSection
        items={state.investigations}
        onAdd={addInvestigation}
        onPatch={(key, patch) => setInvestigations((list) => list.map((t) => (t.key === key ? { ...t, ...patch } : t)))}
        onRemove={(key) => setInvestigations((list) => list.filter((t) => t.key !== key))}
      />

      <AdviceSection
        advice={state.advice}
        followUpDate={state.followUpDate}
        followUpReason={state.followUpReason}
        onChange={(field, value) => set(field, value)}
      />

      <footer className="sticky bottom-0 space-y-2 border-t bg-white py-3">
        <AutosaveStatusBar
          status={autosave.status}
          onRetry={autosave.retryNow}
          onOverwrite={autosave.overwrite}
          onReload={reload}
        />
        {finalizeError ? (
          <p role="alert" className="text-sm text-destructive">
            {finalizeError}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" onClick={() => void autosave.flush()}>
            Save now
          </Button>
          {canFinalize ? (
            <Button type="button" disabled={finalizing || blocked} onClick={() => void finalize()}>
              {finalizing ? "Finalizing…" : "Finalize"}
            </Button>
          ) : null}
        </div>
      </footer>
    </fieldset>
  );
}
