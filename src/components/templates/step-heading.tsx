"use client";

import { useEffect, useRef } from "react";

/** A step title that takes focus when the step appears, so keyboard and screen-reader users land on the new step. */
export function StepHeading({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <h2 ref={ref} tabIndex={-1} className="text-lg font-medium outline-none">
      {children}
    </h2>
  );
}
