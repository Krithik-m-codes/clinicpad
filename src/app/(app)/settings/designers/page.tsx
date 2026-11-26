import Link from "next/link";
import { redirect } from "next/navigation";
import { can } from "@/lib/domain/permissions";
import { DESIGNER_DEFAULT_DAYS, DESIGNER_MAX_DAYS } from "@/lib/domain/designer";
import { requireSession } from "@/server/auth/session";
import { listDesigners } from "@/server/auth/designers";
import { getClinicTimeZone } from "@/server/services/clinic";
import { DesignerList } from "@/components/settings/designer-list";
import { InviteDesignerForm } from "@/components/settings/invite-designer-form";

export const dynamic = "force-dynamic";

export default async function DesignersPage() {
  const session = await requireSession();
  if (!can(session.role, "designer.manage")) redirect("/dashboard");
  const [designers, timeZone] = await Promise.all([listDesigners(session), getClinicTimeZone(session)]);
  if (!designers.ok) throw new Error("setup accounts could not be listed");

  return (
    <div className="max-w-3xl space-y-8">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">Pad setup accounts</h1>
        <p className="text-sm text-muted-foreground">
          Let a ClinicPad setup person (or your own designer) build your pad. The account can work on pad templates only, sees sample data
          instead of patients, and stops working on its own after {DESIGNER_DEFAULT_DAYS} days unless you choose up to {DESIGNER_MAX_DAYS}.
          You check the finished pad with a real patient and publish it yourself.
        </p>
      </div>
      <section className="space-y-3">
        <h2 className="text-lg font-medium">Invite a setup account</h2>
        <InviteDesignerForm />
      </section>
      <section className="space-y-3">
        <h2 className="text-lg font-medium">Current and past setup accounts</h2>
        <DesignerList
          designers={designers.value.map((d) => ({
            membershipId: d.membershipId,
            email: d.email,
            name: d.name,
            status: d.status,
            expiresAt: d.expiresAt.toISOString(),
            createdAt: d.createdAt.toISOString(),
          }))}
          timeZone={timeZone}
        />
      </section>
      <p className="text-sm">
        <Link className="underline" href="/settings">
          Back to clinic settings
        </Link>
      </p>
    </div>
  );
}
