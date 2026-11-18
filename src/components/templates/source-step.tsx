"use client";

export type Source = "image" | "pdf" | "word" | "concierge";

const OPTIONS: { value: Source; label: string; hint: string }[] = [
  { value: "image", label: "Photo or scan", hint: "A JPEG or PNG of the blank pad. A flat scan works best." },
  { value: "pdf", label: "PDF", hint: "The PDF your printer sent, or a scan saved as PDF." },
  { value: "word", label: "Word file", hint: "Open the pad in Word, choose File, Save As, PDF, then pick PDF here." },
  { value: "concierge", label: "Send it to us", hint: "Send a photo of your pad on WhatsApp or email; we set it up and you check it." },
];

export function SourceStep({ value, onChange, pdfEnabled, disabled = false }: { value: Source | null; onChange: (s: Source) => void; pdfEnabled: boolean; disabled?: boolean }) {
  return (
    <fieldset className="space-y-3" disabled={disabled}>
      <legend className="text-lg font-medium">What do you have?</legend>
      {OPTIONS.filter((o) => pdfEnabled || (o.value !== "pdf" && o.value !== "word")).map((option) => (
        <label key={option.value} className="flex cursor-pointer gap-3 rounded-md border p-3 has-[:checked]:border-primary has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring">
          <input type="radio" name="source" value={option.value} checked={value === option.value} onChange={() => onChange(option.value)} aria-describedby={`source-${option.value}-hint`} />
          <span>
            <span className="block font-medium">{option.label}</span>
            <span id={`source-${option.value}-hint`} className="block text-sm text-muted-foreground">
              {option.hint}
            </span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}
