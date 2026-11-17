"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

type Props = { prescriptionId: string; fileName: string };

const PRINT_FAILED = "The prescription could not be prepared for printing. Reload the page and sign in again if asked.";
const SIGNED_OUT = "Your session ended. Reload the page and sign in again.";
const PREPARE_TIMEOUT_MS = 20_000;

export function OutputActions({ prescriptionId, fileName }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState<"print" | "pdf" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const printButton = useRef<HTMLButtonElement | null>(null);
  const mounted = useRef(true);
  const restoreFocus = useRef(false);

  // The Print button is disabled while preparing; focus it once it is enabled again.
  useEffect(() => {
    if (busy === null && restoreFocus.current) {
      restoreFocus.current = false;
      printButton.current?.focus();
    }
  }, [busy]);

  const dropFrame = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    frameRef.current?.remove();
    frameRef.current = null;
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      dropFrame();
    };
  }, [dropFrame]);

  function print() {
    setError(null);
    setBusy("print");
    dropFrame();
    const frame = document.createElement("iframe");
    frame.title = "Prescription print frame";
    frame.tabIndex = -1;
    frame.setAttribute("aria-hidden", "true");
    frame.setAttribute("sandbox", "allow-same-origin allow-modals");
    Object.assign(frame.style, { position: "fixed", right: "0", bottom: "0", width: "0", height: "0", border: "0" });
    /** A frame that was replaced, timed out, or outlived this component must never print or touch state. */
    const current = () => mounted.current && frameRef.current === frame;
    const fail = (message: string) => {
      dropFrame();
      setError(message);
      setBusy(null);
    };
    frame.addEventListener(
      "load",
      () => {
        if (!current()) return;
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = null;
        void (async () => {
          let doc: Document | null = null;
          try {
            doc = frame.contentDocument;
          } catch {
            doc = null;
          }
          const body = doc?.body ?? null;
          if (body?.dataset.rx !== "ready") {
            // data-rx="error": the document is a friendly message; anything else is an unexpected response.
            fail(body?.dataset.rx === "error" ? body.textContent?.trim() || PRINT_FAILED : PRINT_FAILED);
            return;
          }
          try {
            await doc?.fonts?.ready;
          } catch {
            // Printing without waiting is better than not printing.
          }
          if (!current()) return;
          const win = frame.contentWindow;
          win?.addEventListener("afterprint", () => {
            if (frameRef.current === frame) dropFrame();
          });
          try {
            win?.focus();
            win?.print();
          } finally {
            if (frameRef.current === frame) dropFrame();
          }
          if (!mounted.current) return;
          restoreFocus.current = true;
          setBusy(null);
          router.refresh();
        })();
      },
      { once: true },
    );
    timerRef.current = setTimeout(() => {
      if (current()) fail(PRINT_FAILED);
    }, PREPARE_TIMEOUT_MS);
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
        if (type.includes("text/html")) {
          let signedOut = false;
          try {
            signedOut = response.redirected && new URL(response.url).pathname === "/login";
          } catch {
            signedOut = false;
          }
          if (mounted.current) setError(signedOut ? SIGNED_OUT : "The PDF could not be downloaded. Use Print instead.");
          return;
        }
        const body = (await response.json().catch(() => null)) as { message?: string } | null;
        if (mounted.current) setError(body?.message ?? "The PDF could not be downloaded. Use Print instead.");
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
      if (mounted.current) router.refresh();
    } catch {
      if (mounted.current) setError("You appear to be offline. Use Print, or try again when you are connected.");
    } finally {
      if (mounted.current) setBusy(null);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <Button ref={printButton} type="button" onClick={print} disabled={busy !== null}>
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
