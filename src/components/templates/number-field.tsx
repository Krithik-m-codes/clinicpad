"use client";

import { useState } from "react";

type Props = {
  label: string;
  value: number;
  onValue: (n: number) => void;
  /** Applied when the field is left or Enter is pressed. */
  min?: number;
  max?: number;
  step?: number;
  className?: string;
  labelClassName?: string;
};

const parse = (text: string) => (text.trim() === "" || text.trim() === "-" ? Number.NaN : Number(text));

/**
 * A number field that keeps what the person is typing. While typing, a finite number is passed on with only its upper
 * bound applied (so "1" on the way to "12" is not pushed up to the minimum and the field is never rewritten under the
 * cursor); leaving the field or pressing Enter applies both bounds and shows the result. Out of focus it shows the value.
 */
export function NumberField({ label, value, onValue, min, max, step = 0.1, className = "rounded border p-1", labelClassName = "flex flex-col text-xs" }: Props) {
  const [text, setText] = useState<string | null>(null);
  const clamp = (n: number, lower: boolean) => Math.min(max ?? Infinity, lower ? Math.max(min ?? -Infinity, n) : n);
  // Offsets have a real lower bound (-10) that typing "-" or "-1" must not trip over: only bounds below zero apply while typing.
  const typingLower = min !== undefined && min < 0;
  const commit = () => {
    if (text === null) return;
    const n = parse(text);
    if (Number.isFinite(n)) onValue(clamp(n, true));
    setText(null);
  };
  return (
    <label className={labelClassName}>
      {label}
      <input
        type="number"
        step={step}
        min={min}
        max={max}
        value={text ?? String(value)}
        onChange={(e) => {
          setText(e.target.value);
          const n = parse(e.target.value);
          if (Number.isFinite(n)) onValue(clamp(n, typingLower));
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          }
        }}
        className={className}
      />
    </label>
  );
}
