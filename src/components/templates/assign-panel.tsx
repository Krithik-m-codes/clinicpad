"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { assignTemplateAction } from "@/server/actions/templates";
import { Button } from "@/components/ui/button";

type Doctor = { id: string; name: string; isMe: boolean };
type Props = { templateId: string; identity: "dynamic" | "bound"; boundDoctorId: string | null; role: string; doctors: Doctor[] };

/** Who prints on this published pad (decision 9). The server enforces every rule shown here. */
export function AssignPanel({ templateId, identity, boundDoctorId, role, doctors }: Props) {
  const router = useRouter();
  const [doctorId, setDoctorId] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const me = doctors.find((d) => d.isMe) ?? null;
  const bound = doctors.find((d) => d.id === boundDoctorId) ?? null;

  async function run(input: Parameters<typeof assignTemplateAction>[0], done: string) {
    const result = await assignTemplateAction(input);
    setMessage(result.ok ? done : (result.error ?? "Could not change the pad."));
    if (result.ok) router.refresh();
  }

  return (
    <section aria-label="Use this pad" className="space-y-3 rounded-md border p-3 text-sm">
      <h2 className="font-medium">Use this pad</h2>
      {identity === "bound" ? (
        bound && (role === "owner" || bound.isMe) ? (
          <Button type="button" onClick={() => void run({ scope: "doctor", doctorId: bound.id, templateId }, `${bound.name}'s prescriptions now print on this pad.`)}>
            {bound.isMe ? "Use for my prescriptions" : `Use for ${bound.name}`}
          </Button>
        ) : (
          <p>This letterhead belongs to {bound?.name ?? "another doctor"}.</p>
        )
      ) : role === "owner" ? (
        <>
          <Button type="button" onClick={() => void run({ scope: "clinic", templateId }, "Every prescription now prints on this pad, unless a doctor has chosen their own.")}>
            Use for the whole clinic
          </Button>
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col">
              Or for one doctor
              <select value={doctorId} onChange={(e) => setDoctorId(e.target.value)} className="rounded border p-1">
                <option value="">Choose a doctor</option>
                {doctors.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </label>
            <Button type="button" variant="outline" disabled={doctorId === ""} onClick={() => void run({ scope: "doctor", doctorId, templateId }, "That doctor's prescriptions now print on this pad.")}>
              Use for this doctor
            </Button>
          </div>
        </>
      ) : me ? (
        <Button type="button" onClick={() => void run({ scope: "doctor", doctorId: me.id, templateId }, "Your prescriptions now print on this pad.")}>
          Use for my prescriptions
        </Button>
      ) : null}
      <p role="status" aria-live="polite">
        {message}
      </p>
    </section>
  );
}
