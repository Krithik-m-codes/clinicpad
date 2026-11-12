import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { adminDb } from "@/server/db/admin";
import { memberships, users } from "@/server/db/schema";
import { verifyPassword } from "./password";

const credentialsSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(1),
});

export type AuthenticatedUser = {
  id: string;
  email: string;
  name: string;
  tenantId: string;
  role: string;
};

export type ActiveMembership = { tenantId: string; role: string };

// Pre-computed bcrypt hash of a random string. Compared against when the email is
// unknown so response time does not reveal whether an account exists.
const DUMMY_HASH = "$2b$12$1Ax.c.BuJalhXwEjEpDhu.V9TweS1fuUCGemPO8An8kIJhUIG0avS";

/**
 * Auth lookups use the admin connection on purpose: `users` is not readable by the
 * RLS-bound app role, and a membership lookup happens before any tenant is known.
 */
export async function getActiveMembership(userId: string): Promise<ActiveMembership | null> {
  const [membership] = await adminDb
    .select({ tenantId: memberships.tenantId, role: memberships.role })
    .from(memberships)
    .where(and(eq(memberships.userId, userId), eq(memberships.status, "active")))
    .orderBy(asc(memberships.createdAt))
    .limit(1);
  return membership ?? null;
}

export async function authenticateWithCredentials(
  raw: unknown,
): Promise<AuthenticatedUser | null> {
  const parsed = credentialsSchema.safeParse(raw);
  if (!parsed.success) return null;

  const email = parsed.data.email.toLowerCase();
  const [user] = await adminDb.select().from(users).where(eq(users.email, email)).limit(1);

  const passwordOk = await verifyPassword(parsed.data.password, user?.passwordHash ?? DUMMY_HASH);
  if (!user || !user.passwordHash || !passwordOk) return null;

  const membership = await getActiveMembership(user.id);
  if (!membership) return null;

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    tenantId: membership.tenantId,
    role: membership.role,
  };
}
