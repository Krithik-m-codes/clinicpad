"use client";

import { useRef, type KeyboardEvent, type PointerEvent } from "react";
import { TEMPLATE_FIELDS } from "@/lib/rx-render/fields";
import type { OverlayDefinition } from "@/lib/rx-render/overlay-definition";
import { PAPER } from "@/lib/rx-render/paper";
import type { PaperSize } from "@/lib/rx-render/types";
import { BIG_STEP_MM, MOVE_STEP_MM, type EditorAction } from "@/lib/templates/editor-state";

type Props = {
  fileId: string;
  paper: PaperSize;
  definition: OverlayDefinition;
  selected: string | null;
  warnings: Set<string>;
  dispatch: (action: EditorAction) => void;
};

const pct = (mm: number, total: number) => `${(mm / total) * 100}%`;

/**
 * The pad with its boxes. Drag a box with the pointer, or focus it and use the arrow keys (Shift: 5 mm; Alt: resize;
 * Delete: remove). Every change goes through the reducer, which keeps boxes on the page. The background is placed like
 * the renderer places it (top-aligned, cropped above the page-number band).
 */
export function BoxCanvas({ fileId, paper, definition, selected, warnings, dispatch }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: string; x: number; y: number; boxX: number; boxY: number } | null>(null);
  const { widthMm, heightMm } = PAPER[paper];
  const band = definition.pageNumbers.bandMm;
  const mmPerPx = () => widthMm / (host.current?.clientWidth || 1);

  function onPointerDown(event: PointerEvent<HTMLDivElement>, id: string) {
    if (event.button !== 0) return; // a right or middle click must not start a drag
    dispatch({ type: "select", id });
    const box = definition.boxes.find((b) => b.id === id);
    if (!box) return;
    drag.current = { id, x: event.clientX, y: event.clientY, boxX: box.xMm, boxY: box.yMm };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }
  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    const d = drag.current;
    if (!d) return;
    const scale = mmPerPx();
    // From where the drag started, not event by event: a clamped edge forgets nothing.
    dispatch({ type: "set", id: d.id, patch: { xMm: d.boxX + (event.clientX - d.x) * scale, yMm: d.boxY + (event.clientY - d.y) * scale } });
  }
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>, id: string) {
    const step = event.shiftKey ? BIG_STEP_MM : MOVE_STEP_MM;
    const delta: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (event.key in delta) {
      event.preventDefault();
      const [dx, dy] = delta[event.key];
      dispatch(event.altKey ? { type: "resize", id, dwMm: dx, dhMm: dy } : { type: "move", id, dxMm: dx, dyMm: dy });
    } else if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      dispatch({ type: "remove", id });
      host.current?.focus();
    } else if (event.key === "Escape") {
      dispatch({ type: "select", id: null });
      host.current?.focus();
    }
  }

  const flow = definition.flow;
  return (
    <div ref={host} tabIndex={-1} className="relative w-full select-none overflow-hidden border bg-white shadow outline-none" style={{ aspectRatio: `${widthMm} / ${heightMm}` }}>
      <div className="absolute inset-x-0 top-0 overflow-hidden" style={{ height: pct(heightMm - band, heightMm) }}>
        {/* eslint-disable-next-line @next/next/no-img-element -- a private, same-origin image route; next/image would proxy it */}
        <img src={`/templates/files/${fileId}`} alt="" className="h-full w-full object-cover object-top" draggable={false} />
      </div>
      {band > 0 ? (
        <div aria-hidden="true" className="absolute inset-x-0 bottom-0 flex items-center justify-center bg-muted/80 text-[10px] text-muted-foreground" style={{ height: pct(band, heightMm) }}>
          Page numbers
        </div>
      ) : null}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute border-2 border-dashed border-sky-500/70 bg-sky-100/20"
        style={{ left: pct(flow.leftMm, widthMm), right: pct(flow.rightMm, widthMm), top: pct(flow.topMm, heightMm), bottom: pct(flow.bottomMm, heightMm) }}
      >
        <span className="m-1 inline-block rounded bg-sky-600 px-1 text-[10px] text-white">Prescription body</span>
      </div>
      {definition.boxes.map((box) => {
        const label = TEMPLATE_FIELDS[box.field].en;
        const warn = warnings.has(box.id);
        return (
          <div
            key={box.id}
            role="button"
            tabIndex={0}
            aria-pressed={selected === box.id}
            aria-describedby="box-keys-help"
            aria-label={`${label} box at ${box.xMm} by ${box.yMm} mm, ${box.wMm} by ${box.hMm} mm${warn ? ", long values may not fit" : ""}`}
            onPointerDown={(e) => onPointerDown(e, box.id)}
            onPointerMove={onPointerMove}
            onPointerUp={() => (drag.current = null)}
            onPointerCancel={() => (drag.current = null)}
            onKeyDown={(e) => onKeyDown(e, box.id)}
            onFocus={() => dispatch({ type: "select", id: box.id })}
            className={`absolute cursor-move touch-none overflow-hidden border text-[10px] leading-tight outline-none focus-visible:ring-2 focus-visible:ring-ring ${selected === box.id ? "border-primary bg-primary/15" : "border-amber-600 bg-amber-100/40"} ${warn ? "border-2 border-destructive" : ""}`}
            style={{ left: pct(box.xMm, widthMm), top: pct(box.yMm, heightMm), width: pct(box.wMm, widthMm), height: pct(box.hMm, heightMm) }}
          >
            {label}
          </div>
        );
      })}
    </div>
  );
}
