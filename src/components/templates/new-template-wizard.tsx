"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { LabelLanguage, PaperSize } from "@/lib/rx-render/types";
import type { OverlayDefinition } from "@/lib/rx-render/overlay-definition";
import { autoLayout } from "@/lib/templates/auto-layout";
import { buildUploadImage, loadBitmap } from "@/lib/templates/canvas";
import { uploadBackground } from "@/lib/templates/upload-client";
import { createTemplateAction } from "@/server/actions/templates";
import { Button } from "@/components/ui/button";
import { FileStep, type PickedImage } from "./file-step";
import { FitStep, type Fitted } from "./fit-step";
import { NameStep } from "./name-step";
import { SourceStep, type Source } from "./source-step";

type Picked = { bitmap: ImageBitmap; proposedPaper: PaperSize; warning?: string };
type Uploaded = { fileId: string; paper: PaperSize; definition: OverlayDefinition };

/** Source, file, fit, name: about two minutes (spec section 10.1 steps 1-3); the boxes are adjusted in the editor next. */
export function NewTemplateWizard({ pdfEnabled }: { pdfEnabled: boolean }) {
  const router = useRouter();
  const [source, setSource] = useState<Source | null>(null);
  const [picked, setPicked] = useState<Picked | null>(null);
  const [uploaded, setUploaded] = useState<Uploaded | null>(null);
  const [name, setName] = useState("My pad");
  const [labels, setLabels] = useState<LabelLanguage>("en");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function choose(next: Source) {
    setSource(next);
    setPicked(null);
    setUploaded(null);
    setError(null);
  }

  async function onPicked(p: PickedImage) {
    setError(null);
    try {
      setPicked({ bitmap: await loadBitmap(p.blob), proposedPaper: p.proposedPaper, warning: p.warning });
    } catch {
      setError("This file could not be opened as an image. Upload a PNG or JPEG.");
    }
  }

  async function onFitted(f: Fitted) {
    if (!picked) return;
    setBusy(true);
    setError(null);
    try {
      const image = await buildUploadImage(picked.bitmap, f.crop, f.turns, f.paper);
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
      if (result.ok && result.templateId) return router.push(`/templates/${result.templateId}`);
      setError(result.error ?? "The pad could not be created.");
    } catch {
      setError("The pad could not be created. Check the connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  const choosingFile = (source === "image" || source === "pdf") && !picked;
  return (
    <div className="space-y-6">
      <SourceStep value={source} onChange={choose} pdfEnabled={pdfEnabled} />
      {source === "word" ? (
        <div className="space-y-2 text-sm">
          <p>Open your pad in Word, then File, Save As, PDF. Come back and choose PDF.</p>
          <Button type="button" variant="outline" size="sm" onClick={() => choose("pdf")}>
            I have the PDF
          </Button>
        </div>
      ) : null}
      {source === "concierge" ? <p className="text-sm">Send a clear photo of your blank pad to ClinicPad support on WhatsApp or email. We set it up with sample data; you check it with a real patient and publish it.</p> : null}
      {choosingFile ? <FileStep key={source} kind={source} onPicked={(p) => void onPicked(p)} onUseImage={() => choose("image")} /> : null}
      {picked && !uploaded ? (
        <FitStep bitmap={picked.bitmap} proposedPaper={picked.proposedPaper} warning={picked.warning} onFitted={(f) => void onFitted(f)} onBack={() => setPicked(null)} busy={busy} />
      ) : null}
      {uploaded ? <NameStep name={name} labels={labels} busy={busy} onName={setName} onLabels={setLabels} onCreate={() => void create()} /> : null}
      <p role="status" aria-live="polite" className="text-sm text-destructive">
        {error}
      </p>
    </div>
  );
}
