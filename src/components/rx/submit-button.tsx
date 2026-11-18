"use client";

import type { ComponentProps } from "react";
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";

/** A submit button that disables itself while its parent form's action is running, so a double-click cannot submit twice. */
export function SubmitButton(props: Omit<ComponentProps<typeof Button>, "type" | "disabled">) {
  const { pending } = useFormStatus();
  return <Button {...props} type="submit" disabled={pending} />;
}
