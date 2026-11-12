import { redirect } from "next/navigation";
import { auth } from "@/auth";

export type SessionContext = {
  userId: string;
  tenantId: string;
  role: string;
};

/**
 * Resolves the current session or redirects. Tenant and role come from the server-side
 * session (re-read from memberships), never from client input.
 */
export async function requireSession(): Promise<SessionContext> {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  // No active membership: account exists but has no clinic access.
  if (!session.user.tenantId || !session.user.role) redirect("/login?error=no-access");
  return {
    userId: session.user.id,
    tenantId: session.user.tenantId,
    role: session.user.role,
  };
}
