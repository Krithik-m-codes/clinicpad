"use client";

import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

export type AdviceField = "advice" | "followUpDate" | "followUpReason";

type Props = {
  advice: string;
  followUpDate: string;
  followUpReason: string;
  onChange: (field: AdviceField, value: string) => void;
};

export function AdviceSection({ advice, followUpDate, followUpReason, onChange }: Props) {
  // No aria-label on the section: getByLabel("Advice") in the e2e specs must match only the textarea.
  return (
    <section className="grid gap-4 sm:grid-cols-2">
      <div className="space-y-1 sm:col-span-2">
        <label htmlFor="advice" className="text-sm font-medium">
          Advice
        </label>
        <Textarea
          id="advice"
          rows={3}
          className="min-h-[80px]"
          maxLength={2000}
          value={advice}
          onChange={(e) => onChange("advice", e.target.value)}
        />
      </div>
      <div className="space-y-1">
        <label htmlFor="followUpDate" className="text-sm font-medium">
          Follow-up date
        </label>
        <Input
          id="followUpDate"
          type="date"
          value={followUpDate}
          onChange={(e) => onChange("followUpDate", e.target.value)}
        />
      </div>
      <div className="space-y-1">
        <label htmlFor="followUpReason" className="text-sm font-medium">
          Follow-up reason
        </label>
        <Input
          id="followUpReason"
          maxLength={300}
          value={followUpReason}
          onChange={(e) => onChange("followUpReason", e.target.value)}
        />
      </div>
    </section>
  );
}
