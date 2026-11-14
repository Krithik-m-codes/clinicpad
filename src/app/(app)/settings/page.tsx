import { redirect } from "next/navigation";
import { requireSession } from "@/server/auth/session";
import { withTenant } from "@/server/db/tenant";
import { clinics, tenants } from "@/server/db/schema";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const { tenantId, role } = await requireSession();
  if (role !== "owner") redirect("/dashboard");

  const data = await withTenant(tenantId, async (tx) => {
    const [tenant] = await tx.select().from(tenants).limit(1);
    const [clinic] = await tx.select().from(clinics).limit(1);
    return { tenant, clinic };
  });

  const rows: [string, string | undefined][] = [
    ["Clinic", data.tenant?.name],
    ["Plan", data.tenant?.plan],
    ["Data region", data.tenant?.region],
    ["Timezone", data.clinic?.timezone],
    ["Currency", data.clinic?.currency],
  ];

  return (
    <div className="max-w-2xl space-y-6">
      <h1 className="text-2xl font-semibold">Clinic settings</h1>
      <dl className="divide-y rounded-lg border">
        {rows.map(([label, value]) => (
          <div key={label} className="flex justify-between gap-4 p-4 text-sm">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="font-medium">{value ?? "—"}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
