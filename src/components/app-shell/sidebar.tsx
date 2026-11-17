import Link from "next/link";
import { LayoutDashboard, Settings, UserRound, Users } from "lucide-react";

const ALL_STAFF = ["owner", "doctor", "reception", "nurse", "accountant", "pharmacist"] as const;

const items = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard, roles: ALL_STAFF },
  { href: "/patients", label: "Patients", icon: Users, roles: ["owner", "doctor", "reception", "nurse"] },
  { href: "/settings", label: "Settings", icon: Settings, roles: ["owner"] },
  { href: "/settings/profile", label: "My profile", icon: UserRound, roles: ["doctor"] },
] as const;

type SidebarProps = {
  role: string;
  clinicName: string;
  /** Rendered at the bottom of the sidebar, e.g. the sign-out form. */
  footer?: React.ReactNode;
};

/**
 * Navigation is hidden per role as a convenience only. Pages and server actions must
 * still enforce authorization themselves.
 */
export function Sidebar({ role, clinicName, footer }: SidebarProps) {
  const visible = items.filter((item) => (item.roles as readonly string[]).includes(role));

  return (
    <aside className="flex shrink-0 flex-col border-b bg-background md:w-60 md:border-b-0 md:border-r">
      <div className="flex items-center justify-between gap-3 p-4 md:block md:border-b">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{clinicName}</p>
          <p className="text-xs text-muted-foreground">ClinicPad</p>
        </div>
        {footer ? <div className="md:hidden">{footer}</div> : null}
      </div>
      <nav
        className="flex gap-1 overflow-x-auto p-2 md:flex-col"
        aria-label="Main navigation"
      >
        {visible.map((item) => {
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              className="flex items-center gap-2 whitespace-nowrap rounded-md px-3 py-2 text-sm hover:bg-muted"
            >
              <Icon className="h-4 w-4" aria-hidden />
              {item.label}
            </Link>
          );
        })}
      </nav>
      {footer ? <div className="mt-auto hidden border-t p-4 md:block">{footer}</div> : null}
    </aside>
  );
}
