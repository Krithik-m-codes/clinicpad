"use client";

import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";

type Props = { prescriptionId: string; fileName: string };

const PRINT_FAILED = "The prescription could not be prepared for printing. Reload the page and sign in again if asked.";
const SIGNED_OUT = "Your session ended. Reload the page and sign in again.";

export function OutputActions({ prescriptionId, fileName }: Props) {
  const [busy, setBusy] = useState<"print" | "pdf" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const frameRef = useRef<HTMLIFrameElement | null>(null);

  function print() {
    setError(null);
    setBusy("print");
    frameRef.current?.remove();
    const frame = document.createElement("iframe");
    frame.title = "Prescription print frame";
    frame.setAttribute("aria-hidden", "true");
    Object.assign(frame.style, { position: "fixed", right: "0", bottom: "0", width: "0", height: "0", border: "0" });
    frame.addEventListener(
      "load",
      () => {
        let body: HTMLElement | null = null;
        try {
          body = frame.contentDocument?.body ?? null;
        } catch {
          body = null;
        }
        if (body?.dataset.rx === "ready") {
          frame.contentWindow?.focus();
          frame.contentWindow?.print();
        } else {
          // data-rx="error": the document is a friendly message; anything else is an unexpected response.
          setError(body?.dataset.rx === "error" ? body.textContent?.trim() || PRINT_FAILED : PRINT_FAILED);
        }
        setBusy(null);
      },
      { once: true },
    );
    frame.src = `/prescriptions/${prescriptionId}/document?purpose=print`;
    document.body.appendChild(frame);
    frameRef.current = frame;
  }

  async function downloadPdf() {
    setError(null);
    setBusy("pdf");
    try {
      const response = await fetch(`/prescriptions/${prescriptionId}/pdf`, { cache: "no-store" });
      const type = response.headers.get("content-type") ?? "";
      if (!response.ok || !type.includes("application/pdf")) {
        if (response.redirected || type.includes("text/html")) {
          setError(SIGNED_OUT);
          return;
        }
        const body = (await response.json().catch(() => null)) as { message?: string } | null;
        setError(body?.message ?? "The PDF could not be downloaded. Use Print instead.");
        return;
      }
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch {
      setError("You appear to be offline. Use Print, or try again when you are connected.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <Button type="button" onClick={print} disabled={busy !== null}>
          {busy === "print" ? "Preparing…" : "Print"}
        </Button>
        <Button type="button" variant="outline" onClick={downloadPdf} disabled={busy !== null}>
          {busy === "pdf" ? "Generating PDF…" : "Download PDF"}
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
