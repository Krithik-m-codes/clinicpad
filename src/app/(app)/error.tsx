"use client";

import { Button } from "@/components/ui/button";

export default function AppError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  // The error itself is intentionally not rendered: it may contain patient or tenant data.
  return (
    <div role="alert" className="max-w-md space-y-3 rounded-lg border p-6">
      <h1 className="text-lg font-semibold">Something went wrong</h1>
      <p className="text-sm text-muted-foreground">
        We could not load this page. Your data is safe. Try again, and contact support if it keeps
        happening.
      </p>
      <Button onClick={reset} variant="outline">
        Try again
      </Button>
    </div>
  );
}
