import Link from "next/link";
import { redirect } from "next/navigation";
import { requireSession } from "@/server/auth/session";
import { can } from "@/lib/domain/permissions";
import { withTenant } from "@/server/db/tenant";
import { tenants } from "@/server/db/schema";
import { primaryClinic } from "@/server/services/render-snapshot";
import { getClinicSharing } from "@/server/services/clinic";
import { getClinicPad } from "@/server/services/pad-settings";
import { removeLogoAction, uploadLogoAction } from "@/server/actions/settings";
import { ClinicPadForm } from "@/components/settings/clinic-pad-form";
import { SharingForm } from "@/components/settings/sharing-form";
import { ImageUploadForm } from "@/components/settings/image-upload-form";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const session = await requireSession();
  if (!can(session.role, "settings.clinic")) {
    redirect(can(session.role, "settings.profile") ? "/settings/profile" : "/dashboard");
  }

  const data = await withTenant(session.tenantId, async (tx) => {
    const [tenant] = await tx.select().from(tenants).limit(1);
    return { tenant, clinic: await primaryClinic(tx, session.tenantId) };
  });
  const pad = await getClinicPad(session);
  const sharing = await getClinicSharing(session);

  const rows: [string, string | undefined][] = [
    ["Clinic (pad name)", data.clinic?.name],
    ["Account name", data.tenant?.name],
    ["Plan", data.tenant?.plan],
    ["Data region", data.tenant?.region],
    ["Timezone", data.clinic?.timezone],
    ["Currency", data.clinic?.currency],
  ];

  return (
    <div className="max-w-3xl space-y-8">
      <h1 className="text-2xl font-semibold">Clinic settings</h1>
      <dl className="divide-y rounded-lg border">
        {rows.map(([label, value]) => (
          <div key={label} className="flex justify-between gap-4 p-4 text-sm">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="font-medium">{value ?? "—"}</dd>
          </div>
        ))}
      </dl>

      {pad.ok ? (
        <>
          <section className="space-y-3">
            <h2 className="text-lg font-medium">Prescription pad</h2>
            <ClinicPadForm initial={pad.value} />
          </section>
          <section className="space-y-3">
            <h2 className="text-lg font-medium">Logo</h2>
            <ImageUploadForm
              label="Clinic logo"
              hint="PNG or JPEG, up to 512 KB and 2000 x 2000 pixels. Printed at the top of every page."
              current={pad.value.logo}
              upload={uploadLogoAction}
              remove={removeLogoAction}
            />
          </section>
        </>
      ) : (
        <p className="text-sm text-destructive">{pad.message}</p>
      )}

      {sharing.ok ? (
        <section className="space-y-3">
          <h2 className="text-lg font-medium">Sharing</h2>
          <SharingForm enabled={sharing.value.enabled} />
        </section>
      ) : null}

      <p className="text-sm">
        <Link className="underline" href="/settings/profile">
          Edit your doctor profile
        </Link>{" "}
        (name, qualifications, registration number, signature).
      </p>
    </div>
  );
}
