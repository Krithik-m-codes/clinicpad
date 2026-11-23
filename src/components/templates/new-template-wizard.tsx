"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { LabelLanguage, PaperSize } from "@/lib/rx-render/types";
import type { OverlayDefinition } from "@/lib/rx-render/overlay-definition";
import { autoLayout } from "@/lib/templates/auto-layout";
import { buildUploadImage, loadBitmap } from "@/lib/templates/canvas";
import { uploadBackground } from "@/lib/templates/upload-client";
import { createTemplateAction } from "@/server/actions/templates";
import { Button } from "@/components/ui/button";
import { FileStep, IMAGE_LIMIT } from "./file-step";
import { FitStep, type Fitted } from "./fit-step";
import { NameStep } from "./name-step";
import { PDF_ERRORS, readPdfPage } from "./pdf-source";
import { SourceStep, type Source } from "./source-step";
import { PDF_INTAKE_LIMITS } from "@/lib/templates/pdf-intake";

type Picked = { bitmap: ImageBitmap; proposedPaper: PaperSize; warning?: string };
type PdfSource = { bytes: ArrayBuffer; pageCount: number; page: number };
type Uploaded = { fileId: string; paper: PaperSize; definition: OverlayDefinition };

/** Source, file, fit, name: about two minutes (spec section 10.1 steps 1-3); the boxes are adjusted in the editor next. */
export function NewTemplateWizard({ pdfEnabled }: { pdfEnabled: boolean }) {
  const router = useRouter();
  const [source, setSource] = useState<Source | null>(null);
  const [picked, setPicked] = useState<Picked | null>(null);
  const [pdf, setPdf] = useState<PdfSource | null>(null);
  const [uploaded, setUploaded] = useState<Uploaded | null>(null);
  const [name, setName] = useState("My pad");
  const [labels, setLabels] = useState<LabelLanguage>("en");
  const [busy, setBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState("Uploading…");
  const [error, setError] = useState<string | null>(null);
  // Every start of a file read, source change or step back takes a new number; an older read that finishes late is dropped.
  const generation = useRef(0);
  const current = useRef<Picked | null>(null);

  function swap(next: Picked | null) {
    const old = current.current;
    current.current = next;
    setPicked(next);
    old?.bitmap.close?.();
  }
  useEffect(() => () => current.current?.bitmap.close?.(), []);

  function reset() {
    generation.current += 1;
    swap(null);
    setPdf(null);
    setUploaded(null);
    setError(null);
    setBusy(false);
  }

  function choose(next: Source) {
    reset();
    setSource(next);
  }

  /** Decodes a picked image and shows the fit step; false when this read is stale or failed. */
  async function show(blob: Blob, proposedPaper: PaperSize, warning: string | undefined, token: number): Promise<boolean> {
    let bitmap: ImageBitmap;
    try {
      bitmap = await loadBitmap(blob);
    } catch {
      if (token === generation.current) setError("This file could not be opened as an image. Upload a PNG or JPEG.");
      return false;
    }
    if (token !== generation.current) {
      bitmap.close?.();
      return false;
    }
    swap({ bitmap, proposedPaper, warning });
    return true;
  }

  async function loadPdfPage(bytes: ArrayBuffer, page: number, token: number) {
    setBusy(true);
    setBusyLabel("Reading the PDF…");
    setError(null);
    try {
      const result = await readPdfPage(bytes, page);
      if (token !== generation.current) return;
      if (!result.ok) return setError(result.message);
      if (await show(result.blob, result.proposedPaper, result.warning, token)) setPdf({ bytes, pageCount: result.pageCount, page });
    } catch {
      if (token === generation.current) setError(PDF_ERRORS.unreadable);
    } finally {
      if (token === generation.current) setBusy(false);
    }
  }

  async function onFile(file: File) {
    const token = ++generation.current;
    setError(null);
    if (source === "image") {
      // The bytes decide on the server; here only the size is checked so the browser does not try to decode a huge file.
      if (file.size > IMAGE_LIMIT) return setError("The image is larger than 15 MB. Scan at a lower resolution.");
      setBusy(true);
      setBusyLabel("Reading the image…");
      try {
        await show(file, "A4", undefined, token);
      } finally {
        if (token === generation.current) setBusy(false);
      }
      return;
    }
    if (file.size > PDF_INTAKE_LIMITS.maxBytes) return setError(PDF_ERRORS.too_large);
    setBusy(true);
    setBusyLabel("Reading the PDF…");
    try {
      await loadPdfPage(await file.arrayBuffer(), 1, token);
    } catch {
      if (token === generation.current) setError(PDF_ERRORS.unreadable);
    }
  }

  async function onFitted(f: Fitted) {
    const bitmap = current.current?.bitmap;
    if (!bitmap) return;
    setBusy(true);
    setBusyLabel("Uploading…");
    setError(null);
    try {
      const image = await buildUploadImage(bitmap, f.crop, f.turns, f.paper);
      if (!image) return setError("The pad image is too large even after shrinking it. Crop it more tightly.");
      const result = await uploadBackground(image.blob);
      if (!result.ok) return setError(result.message);
      setUploaded({ fileId: result.fileId, paper: f.paper, definition: autoLayout(f.paper, image.darkness) });
    } catch {
      setError("The pad image could not be prepared in this browser. Try a smaller image.");
    } finally {
      setBusy(false);
    }
  }

  async function create() {
    if (!uploaded) return;
    setBusy(true);
    setError(null);
    try {
      const result = await createTemplateAction({ name, fileId: uploaded.fileId, paperSize: uploaded.paper, labels, definition: uploaded.definition });
      if (result.ok && result.templateId) {
        router.push(`/templates/${result.templateId}`);
        return; // stay busy while the page changes, so a second click cannot create the pad twice
      }
      setError(result.error ?? "The pad could not be created.");
    } catch {
      setError("The pad could not be created. Check the connection and try again.");
    }
    setBusy(false);
  }

  const choosingFile = (source === "image" || source === "pdf") && !picked;
  return (
    <div className="space-y-6">
      <SourceStep value={source} onChange={choose} pdfEnabled={pdfEnabled} disabled={busy} />
      {source === "word" ? (
        <div className="space-y-2 text-sm">
          <p>Open your pad in Word, then File, Save As, PDF. Come back and choose PDF.</p>
          <Button type="button" variant="outline" size="sm" onClick={() => choose("pdf")}>
            I have the PDF
          </Button>
        </div>
      ) : null}
      {source === "concierge" ? <p className="text-sm">Send a clear photo of your blank pad to ClinicPad support on WhatsApp or email. We set it up with sample data; you check it with a real patient and publish it.</p> : null}
      {choosingFile ? <FileStep key={source} kind={source} busy={busy} showFallback={Boolean(error)} onFile={(f) => void onFile(f)} onUseImage={() => choose("image")} /> : null}
      {picked && !uploaded ? (
        <FitStep
          bitmap={picked.bitmap}
          proposedPaper={picked.proposedPaper}
          warning={picked.warning}
          pdf={pdf ?? undefined}
          onPage={(page) => pdf && void loadPdfPage(pdf.bytes, page, ++generation.current)}
          onFitted={(f) => void onFitted(f)}
          onBack={() => {
            generation.current += 1;
            swap(null);
            setPdf(null);
            setError(null);
          }}
          busy={busy}
          busyLabel={busyLabel}
        />
      ) : null}
      {uploaded ? <NameStep name={name} labels={labels} busy={busy} onName={setName} onLabels={setLabels} onCreate={() => void create()} /> : null}
      <p role="status" aria-live="polite" className="text-sm text-destructive">
        {error}
      </p>
    </div>
  );
}
