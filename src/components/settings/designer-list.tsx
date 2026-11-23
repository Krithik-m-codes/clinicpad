"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DESIGNER_MAX_DAYS } from "@/lib/domain/designer";
import { extendDesignerAction, revokeDesignerAction, type DesignerFormState } from "@/server/actions/designers";

export type DesignerListItem = {
  membershipId: string;
  email: string;
  name: string;
  status: "active" | "expired" | "revoked";
  expiresAt: string;
  createdAt: string;
};

const STATUS_TEXT = { active: "Active", expired: "Expired", revoked: "Revoked" } as const;

function whenText(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone, day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true }).format(new Date(iso));
}

function Row({ item, timeZone }: { item: DesignerListItem; timeZone: string }) {
  const [extendState, extend, extending] = useActionState(extendDesignerAction, {} as DesignerFormState);
  const [revokeState, revoke, revoking] = useActionState(revokeDesignerAction, {} as DesignerFormState);
  const error = extendState.error ?? revokeState.error;
  const when =
    item.status === "revoked" ? " (access ended)" : item.status === "expired" ? ` on ${whenText(item.expiresAt, timeZone)}` : ` until ${whenText(item.expiresAt, timeZone)}`;
  return (
    <li className="space-y-2 p-4 text-sm" data-testid="designer-row">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-medium">{item.name}</p>
          <p className="truncate text-muted-foreground">{item.email}</p>
        </div>
        <p>
          <span className="font-medium" data-testid="designer-status">
            {STATUS_TEXT[item.status]}
          </span>
          <span className="text-muted-foreground">{when}</span>
        </p>
      </div>
      {item.status !== "revoked" ? (
        <div className="flex flex-wrap items-end gap-3">
          <form action={extend} className="flex items-end gap-2">
            <input type="hidden" name="membershipId" value={item.membershipId} />
            <label className="space-y-1">
              <span className="block text-xs text-muted-foreground">Extend by (days from today)</span>
              <Input name="days" type="number" inputMode="numeric" min={1} max={DESIGNER_MAX_DAYS} step={1} defaultValue={7} className="w-24" required />
            </label>
            <Button type="submit" variant="outline" disabled={extending}>
              Extend
            </Button>
          </form>
          <form action={revoke}>
            <input type="hidden" name="membershipId" value={item.membershipId} />
            <Button type="submit" variant="destructive" disabled={revoking}>
              Revoke now
            </Button>
          </form>
        </div>
      ) : null}
      {error ? <p className="text-destructive">{error}</p> : null}
    </li>
  );
}

export function DesignerList({ designers, timeZone }: { designers: DesignerListItem[]; timeZone: string }) {
  if (designers.length === 0) return <p className="text-sm text-muted-foreground">No setup accounts yet.</p>;
  return (
    <ul className="divide-y rounded-lg border" aria-label="Setup accounts">
      {designers.map((d) => (
        <Row key={d.membershipId} item={d} timeZone={timeZone} />
      ))}
    </ul>
  );
}
