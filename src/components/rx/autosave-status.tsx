"use client";

import { Button } from "@/components/ui/button";
import { FIELDS as VITAL_FIELDS } from "./vitals-section";
import { AMBIGUOUS_CONFLICT_MESSAGE, type AutosaveStatus } from "@/lib/rx/autosave";

type Props = {
  status: AutosaveStatus;
  onRetry: () => void;
  onOverwrite: () => void;
  /** Loads the server's version and drops local edits (the page discards the autosaver first). */
  onReload: () => void;
};

function time(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

const PATH_LABELS: Record<string, string> = {
  items: "medicines",
  investigations: "tests",
  ...Object.fromEntries(VITAL_FIELDS.map((f) => [f.key, f.label])),
};

/** "items.2.dose" becomes "medicines 3 \u00b7 dose": list positions are counted from 1, as the doctor sees them. */
export function describePath(path: string): string {
  const parts: string[] = [];
  for (const segment of path.split(".")) {
    if (/^\d+$/.test(segment) && parts.length > 0) parts[parts.length - 1] += ` ${Number(segment) + 1}`;
    else parts.push(PATH_LABELS[segment] ?? segment);
  }
  return parts.join(" \u00b7 ");
}

/** The server refuses a whole snapshot for one bad field, so everything since the last save is unsaved. */
function invalidText(status: Extract<AutosaveStatus, { state: "invalid" }>): string {
  const since = status.savedAt ? time(status.savedAt) : "you opened this draft";
  const where = status.path ? ` (${describePath(status.path)})` : "";
  return `Nothing since ${since} is saved \u2014 ${status.message}${where}`;
}

/** Always tells the truth: "saved" only after the server confirmed the latest snapshot. */
export function AutosaveStatusBar({ status, onRetry, onOverwrite, onReload }: Props) {
  switch (status.state) {
    case "saved":
      return (
        <p role="status" className="text-sm text-muted-foreground">
          {status.savedAt ? `All changes saved at ${time(status.savedAt)}` : "No unsaved changes"}
        </p>
      );
    case "pending":
      return (
        <p role="status" className="text-sm text-muted-foreground">
          Unsaved changes…
        </p>
      );
    case "saving":
      return (
        <p role="status" className="text-sm text-muted-foreground">
          Saving…
        </p>
      );
    case "retrying":
      return (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-amber-800">
          <span>{status.message}</span>
          <Button type="button" size="sm" variant="outline" onClick={onRetry}>
            Retry now
          </Button>
        </div>
      );
    case "invalid":
      return (
        <p role="alert" className="text-sm text-destructive">
          {invalidText(status)}
        </p>
      );
    case "conflict": {
      const ambiguous = status.message === AMBIGUOUS_CONFLICT_MESSAGE;
      return (
        <div role="alert" className="space-y-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm">
          <p>{ambiguous ? status.message : `${status.message} Your version has not been saved.`}</p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" variant="outline" onClick={onReload}>
              {ambiguous ? "Load saved version" : "Reload latest version"}
            </Button>
            <Button type="button" size="sm" onClick={onOverwrite}>
              Keep my version
            </Button>
          </div>
        </div>
      );
    }
    case "locked":
      return (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-destructive">
          <span>{status.message}</span>
          <Button type="button" size="sm" variant="outline" onClick={onReload}>
            Reload
          </Button>
        </div>
      );
  }
}
