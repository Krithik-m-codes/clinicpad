import { eq, or } from "drizzle-orm";
import { adminDb } from "@/server/db/admin";
import {
  auditEvents,
  branches,
  clinics,
  doctors,
  memberships,
  tenants,
  users,
} from "@/server/db/schema";
import { hashPassword } from "@/server/auth/password";
import { newId } from "@/lib/domain/ids";
import { pgErrorInfo } from "@/server/db/errors";
import { onboardingSchema, type OnboardingInput } from "@/server/validation/onboarding";

export type CreateClinicResult =
  | { ok: true; tenantId: string; userId: string }
  | { ok: false; field: string; error: string };

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 40);
}

/**
 * Creates tenant + owner user + membership + clinic + primary branch + doctor + audit
 * event in one transaction. Uses the admin connection: there is no tenant yet, so the
 * RLS-bound app role cannot insert. Never call this with client-supplied tenant IDs.
 */
export async function createClinicAccount(raw: OnboardingInput): Promise<CreateClinicResult> {
  const parsed = onboardingSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, field: String(issue.path[0] ?? "form"), error: issue.message };
  }
  const input = parsed.data;

  const existing = await adminDb
    .select({ email: users.email, phone: users.phone })
    .from(users)
    .where(or(eq(users.email, input.email), eq(users.phone, input.phone)))
    .limit(1);

  if (existing.length > 0) {
    const field = existing[0].email === input.email ? "email" : "phone";
    return { ok: false, field, error: `This ${field} is already registered. Try signing in.` };
  }

  const passwordHash = await hashPassword(input.password);

  try {
    const result = await adminDb.transaction(async (tx) => {
      const tenantId = newId();
      const userId = newId();

      await tx.insert(tenants).values({
        id: tenantId,
        name: input.clinicName,
        slug: `${slugify(input.clinicName) || "clinic"}-${tenantId.slice(-8)}`,
        plan: "free",
      });

      await tx.insert(users).values({
        id: userId,
        email: input.email,
        phone: input.phone,
        name: input.doctorName,
        passwordHash,
      });

      await tx.insert(memberships).values({ tenantId, userId, role: "owner", status: "active" });

      const [clinic] = await tx
        .insert(clinics)
        .values({
          tenantId,
          name: input.clinicName,
          city: input.city,
          country: input.country,
          timezone: input.timezone,
          currency: input.currency,
        })
        .returning();

      const [branch] = await tx
        .insert(branches)
        .values({ tenantId, clinicId: clinic.id, name: "Main Branch", isPrimary: true })
        .returning();

      await tx.insert(doctors).values({
        tenantId,
        userId,
        primaryBranchId: branch.id,
        specialties: [],
        consultationFeePaise: 0,
      });

      await tx.insert(auditEvents).values({
        tenantId,
        actorUserId: userId,
        action: "tenant.created",
        entityType: "tenant",
        entityId: tenantId,
        after: { name: input.clinicName, plan: "free" },
      });

      return { tenantId, userId };
    });

    return { ok: true, ...result };
  } catch (error) {
    // Lost a race with a concurrent sign-up for the same email/phone.
    const { code, constraint } = pgErrorInfo(error);
    if (code === "23505") {
      const field = constraint?.includes("phone") ? "phone" : "email";
      return { ok: false, field, error: `This ${field} is already registered. Try signing in.` };
    }
    throw error;
  }
}
