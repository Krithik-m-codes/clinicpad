"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { browserFamily, overlayPrintsInBrowser, PRINT_PDF_HINT } from "@/lib/templates/print-support";

type Props = { prescriptionId: string; fileName: string; /** The prescription prints on a custom overlay pad (Plan 2A). */ printsOnOverlay?: boolean };

const PRINT_FAILED = "The prescription could not be prepared for printing. Reload the page and sign in again if asked.";
const SIGNED_OUT = "Your session ended. Reload the page and sign in again.";
const PREPARE_TIMEOUT_MS = 20_000;
const POPUP_BLOCKED = "Your browser blocked the PDF window. Allow pop-ups for this site, then press Print again.";
const OPEN_HOLD_MS = 3_000;
/** Some browsers print asynchronously; the frame must outlive print() and goes on afterprint or after this long. */
const PRINT_FRAME_LIFETIME_MS = 60_000;

export function OutputActions({ prescriptionId, fileName, printsOnOverlay = false }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState<"print" | "pdf" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lifetimeRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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
    if (lifetimeRef.current) clearTimeout(lifetimeRef.current);
    lifetimeRef.current = null;
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
    // Overlay pads print from HTML only where the S1 check passed (override 16); elsewhere the paper PDF opens in a new
    // tab (window.open runs synchronously in the click, so popup blockers allow it). The server logs it as a print.
    if (printsOnOverlay && !overlayPrintsInBrowser(browserFamily(navigator.userAgent, "userAgentData" in navigator))) {
      // No "noopener" feature: it makes window.open return null even when the tab opened, hiding a blocked pop-up.
      const opened = window.open(`/prescriptions/${prescriptionId}/pdf?purpose=print`, "_blank");
      if (!opened) {
        setError(POPUP_BLOCKED);
        return;
      }
      opened.opener = null;
      setError(null);
      // The server logs a print per request: hold the button so a second click cannot open and log it twice.
      setBusy("print");
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        if (!mounted.current) return;
        setBusy(null);
        router.refresh();
      }, OPEN_HOLD_MS);
      return;
    }
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
          // The frame is removed on afterprint, on the lifetime timer, on a new print, or on unmount; never right
          // after print() returns, because Firefox and Safari may still be rendering the pages.
          lifetimeRef.current = setTimeout(() => {
            if (frameRef.current === frame) dropFrame();
          }, PRINT_FRAME_LIFETIME_MS);
          try {
            win?.focus();
            win?.print();
          } catch {
            dropFrame();
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
      {printsOnOverlay ? <p className="text-xs text-muted-foreground">{PRINT_PDF_HINT}</p> : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
