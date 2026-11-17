import { requireSession } from "@/server/auth/session";
import { signOutAction } from "@/server/auth/sign-out";
import { withTenant } from "@/server/db/tenant";
import { clinics } from "@/server/db/schema";
import { Sidebar } from "@/components/app-shell/sidebar";
import { Button } from "@/components/ui/button";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  // Role and tenant come from the server-side session, which re-reads the membership.
  const session = await requireSession();

  const clinic = await withTenant(session.tenantId, async (tx) => {
    const [row] = await tx.select({ name: clinics.name }).from(clinics).limit(1);
    return row;
  });

  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-background focus:px-3 focus:py-2 focus:shadow"
      >
        Skip to content
      </a>
      <Sidebar
        role={session.role}
        clinicName={clinic?.name ?? "ClinicPad"}
        footer={
          <form action={signOutAction} data-leave-guard="">
            <Button type="submit" variant="outline" size="sm">
              Sign out
            </Button>
          </form>
        }
      />
      <main id="main" tabIndex={-1} className="min-w-0 flex-1 p-4 outline-none md:p-6">{children}</main>
    </div>
  );
}
