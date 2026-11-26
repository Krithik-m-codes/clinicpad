import { and, count, desc, eq, gt, sql } from "drizzle-orm";
import { z } from "zod";
import { can } from "@/lib/domain/permissions";
import {
  DESIGNER_MAX_ACTIVE,
  DESIGNER_MAX_DAYS,
  DESIGNER_MAX_PER_DAY,
  designerStatus,
  generateTemporaryPassword,
  parseDesignerDays,
  type DesignerStatus,
} from "@/lib/domain/designer";
import { isUuid } from "@/lib/domain/ids";
import { fail, invalidFrom, ok, type Result } from "@/lib/result";
import { adminDb } from "@/server/db/admin";
import { pgErrorInfo } from "@/server/db/errors";
import { auditEvents, memberships, users } from "@/server/db/schema";
import type { ServiceContext } from "@/server/services/context";
import { cleanRequiredText } from "@/server/validation/text";
import { hashPassword } from "./password";

/*
 * Concierge designer accounts (Plan 2C, ADR-0052). The owner creates a temporary account that can edit pad templates only.
 *
 * This module uses the ADMIN connection on purpose: `users` is not readable by the RLS-bound role, and a designer is a
 * user that does not exist yet. That makes every query here responsible for its own tenant scope: each one filters by
 * `ctx.tenantId` (from the server session, never from input) AND `role = 'designer'`, so a membership id from another
 * clinic, or the id of an owner, is simply "not found". Audit events are written in the same transaction.
 *
 * Never put the temporary password, its hash or the email address into an audit payload, a log line or an error.
 */

const DAY_MS = 86_400_000;
const FORBIDDEN = "Only the clinic owner can manage setup accounts.";
const NOT_FOUND = "That setup account was not found.";

const inviteSchema = z.object({
  email: z.string().trim().toLowerCase().max(254, "Use a shorter email").email("Enter a valid email"),
  name: cleanRequiredText(120, "Enter a name for this account"),
});

export type DesignerRow = {
  membershipId: string;
  userId: string;
  email: string;
  name: string;
  status: DesignerStatus;
  expiresAt: Date;
  createdAt: Date;
};

export type InviteOutcome = { membershipId: string; email: string; password: string; expiresAt: Date; reinvited: boolean };

/** One designer operation at a time per clinic: the active-designer cap and the user lookup cannot race each other. */
async function lockDesigners(tx: Pick<typeof adminDb, "execute">, tenantId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`designers:${tenantId}`}, 0))`);
}

function daysOrFail(raw: unknown): { days: number } | ReturnType<typeof fail> {
  const parsed = parseDesignerDays(raw);
  return parsed.ok ? { days: parsed.days } : fail("invalid", `Choose a whole number of days from 1 to ${DESIGNER_MAX_DAYS}.`, "days");
}

export async function inviteDesigner(ctx: ServiceContext, raw: { email?: unknown; name?: unknown; days?: unknown }): Promise<Result<InviteOutcome>> {
  if (!can(ctx.role, "designer.manage")) return fail("forbidden", FORBIDDEN);
  const parsed = inviteSchema.safeParse({ email: raw.email, name: raw.name });
  if (!parsed.success) return invalidFrom(parsed.error);
  const days = daysOrFail(raw.days);
  if (!("days" in days)) return days;
  const { email, name } = parsed.data;

  const password = generateTemporaryPassword();
  const passwordHash = await hashPassword(password);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + days.days * DAY_MS);
  const conflict = fail("conflict", "This email cannot be used for a setup account. Use a new email address that has no ClinicPad account.", "email");

  try {
    return await adminDb.transaction(async (tx): Promise<Result<InviteOutcome>> => {
      await lockDesigners(tx, ctx.tenantId);

      const [existing] = await tx.select().from(users).where(eq(users.email, email)).limit(1);
      let userId: string;
      let membershipId: string;
      let reinvited = false;
      let alreadyCounted = false;
      let before: Record<string, unknown> | undefined;

      // Bounds what a hostile or careless owner can do with this form: new accounts and re-invites per clinic per day.
      const [{ recent }] = await tx
        .select({ recent: count() })
        .from(memberships)
        .where(and(eq(memberships.tenantId, ctx.tenantId), eq(memberships.role, "designer"), gt(memberships.createdAt, new Date(now.getTime() - DAY_MS))));
      if (recent >= DESIGNER_MAX_PER_DAY) return fail("conflict", `At most ${DESIGNER_MAX_PER_DAY} setup accounts can be created or re-invited per day. Try again tomorrow.`);

      if (existing) {
        // Sign-in uses the oldest active membership, so an account with any other membership could never reach this
        // clinic, and replacing its password would take it over. Only a former designer of THIS clinic may be re-invited.
        const held = await tx.select().from(memberships).where(eq(memberships.userId, existing.id));
        const reusable = held.length > 0 && held.every((m) => m.tenantId === ctx.tenantId && m.role === "designer") && !existing.isPlatformAdmin;
        if (!reusable) return conflict;
        userId = existing.id;
        membershipId = held[0].id;
        reinvited = true;
        alreadyCounted = held[0].status === "active" && held[0].expiresAt !== null && held[0].expiresAt.getTime() > now.getTime();
        before = { status: held[0].status, expiresAt: held[0].expiresAt?.toISOString() ?? null, nameChanged: existing.name !== name };
      }

      if (!alreadyCounted) {
        const [{ n }] = await tx
          .select({ n: count() })
          .from(memberships)
          .where(and(eq(memberships.tenantId, ctx.tenantId), eq(memberships.role, "designer"), eq(memberships.status, "active"), gt(memberships.expiresAt, now)));
        if (n >= DESIGNER_MAX_ACTIVE) return fail("conflict", `A clinic can have at most ${DESIGNER_MAX_ACTIVE} active setup accounts. Revoke one first.`);
      }

      if (existing) {
        await tx.update(users).set({ passwordHash, name }).where(eq(users.id, existing.id));
        // createdAt restarts: sessions issued before this re-invite stop working (see getActiveMembership, ADR-0052), so
        // an old person's still-valid sign-in cannot return, and a leaked password is cut off together with its sessions.
        await tx.update(memberships).set({ status: "active", expiresAt, createdAt: now }).where(and(eq(memberships.id, membershipId!), eq(memberships.tenantId, ctx.tenantId)));
      } else {
        const [user] = await tx.insert(users).values({ email, name, passwordHash }).returning({ id: users.id });
        userId = user.id;
        const [member] = await tx
          .insert(memberships)
          .values({ tenantId: ctx.tenantId, userId, role: "designer", status: "active", expiresAt })
          .returning({ id: memberships.id });
        membershipId = member.id;
      }

      await tx.insert(auditEvents).values({
        tenantId: ctx.tenantId,
        actorUserId: ctx.userId,
        action: "designer.invited",
        entityType: "membership",
        entityId: membershipId!,
        before,
        after: { designerUserId: userId!, expiresAt: expiresAt.toISOString(), days: days.days, reinvited, passwordRotated: reinvited },
      });
      return ok({ membershipId: membershipId!, email, password, expiresAt, reinvited });
    });
  } catch (error) {
    // Lost a race with another clinic (or sign-up) for the same new email.
    if (pgErrorInfo(error).code === "23505") return conflict;
    throw error;
  }
}

/** Sets the expiry to now + days. Only a later date is accepted; an expired (not revoked) account comes back to life. */
export async function extendDesigner(ctx: ServiceContext, membershipId: string, rawDays: unknown): Promise<Result<{ expiresAt: Date }>> {
  if (!can(ctx.role, "designer.manage")) return fail("forbidden", FORBIDDEN);
  if (!isUuid(membershipId)) return fail("not_found", NOT_FOUND);
  const days = daysOrFail(rawDays);
  if (!("days" in days)) return days;

  return adminDb.transaction(async (tx): Promise<Result<{ expiresAt: Date }>> => {
    await lockDesigners(tx, ctx.tenantId);
    const [row] = await tx
      .select()
      .from(memberships)
      .where(and(eq(memberships.id, membershipId), eq(memberships.tenantId, ctx.tenantId), eq(memberships.role, "designer")))
      .for("update");
    if (!row) return fail("not_found", NOT_FOUND);
    if (row.status !== "active") return fail("conflict", "This setup account was revoked. Invite it again instead.");
    const now = new Date();
    const expiresAt = new Date(now.getTime() + days.days * DAY_MS);
    if (row.expiresAt && row.expiresAt.getTime() >= expiresAt.getTime()) return fail("invalid", "This account already lasts longer than that.", "days");
    // Reviving an expired account counts against the same cap as a new invite.
    if (!row.expiresAt || row.expiresAt.getTime() <= now.getTime()) {
      const [{ n }] = await tx
        .select({ n: count() })
        .from(memberships)
        .where(and(eq(memberships.tenantId, ctx.tenantId), eq(memberships.role, "designer"), eq(memberships.status, "active"), gt(memberships.expiresAt, now)));
      if (n >= DESIGNER_MAX_ACTIVE) return fail("conflict", `A clinic can have at most ${DESIGNER_MAX_ACTIVE} active setup accounts. Revoke one first.`);
    }
    await tx.update(memberships).set({ expiresAt }).where(eq(memberships.id, row.id));
    await tx.insert(auditEvents).values({
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action: "designer.extended",
      entityType: "membership",
      entityId: row.id,
      before: { expiresAt: row.expiresAt?.toISOString() ?? null },
      after: { expiresAt: expiresAt.toISOString(), days: days.days },
    });
    return ok({ expiresAt });
  });
}

/** Ends the account's access now. The session callback re-reads memberships on every request, so it takes effect at once. */
export async function revokeDesigner(ctx: ServiceContext, membershipId: string): Promise<Result<{ revoked: true }>> {
  if (!can(ctx.role, "designer.manage")) return fail("forbidden", FORBIDDEN);
  if (!isUuid(membershipId)) return fail("not_found", NOT_FOUND);

  return adminDb.transaction(async (tx): Promise<Result<{ revoked: true }>> => {
    await lockDesigners(tx, ctx.tenantId);
    const [row] = await tx
      .select()
      .from(memberships)
      .where(and(eq(memberships.id, membershipId), eq(memberships.tenantId, ctx.tenantId), eq(memberships.role, "designer")))
      .for("update");
    if (!row) return fail("not_found", NOT_FOUND);
    if (row.status === "disabled") return fail("conflict", "This setup account is already revoked.");
    await tx.update(memberships).set({ status: "disabled" }).where(eq(memberships.id, row.id));
    await tx.insert(auditEvents).values({
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action: "designer.revoked",
      entityType: "membership",
      entityId: row.id,
      before: { status: row.status, expiresAt: row.expiresAt?.toISOString() ?? null },
      after: { status: "disabled" },
    });
    return ok({ revoked: true });
  });
}

/** The clinic's setup accounts, newest first, with a derived status. Never selects the password hash. */
export async function listDesigners(ctx: ServiceContext): Promise<Result<DesignerRow[]>> {
  if (!can(ctx.role, "designer.manage")) return fail("forbidden", FORBIDDEN);
  const rows = await adminDb
    .select({
      membershipId: memberships.id,
      userId: users.id,
      email: users.email,
      name: users.name,
      status: memberships.status,
      expiresAt: memberships.expiresAt,
      createdAt: memberships.createdAt,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.tenantId, ctx.tenantId), eq(memberships.role, "designer")))
    .orderBy(desc(memberships.createdAt));
  const now = new Date();
  return ok(
    rows.map((r) => ({
      membershipId: r.membershipId,
      userId: r.userId,
      email: r.email,
      name: r.name,
      status: designerStatus(r, now),
      // A designer membership always has an expiry (CHECK); the fallback only keeps the type honest.
      expiresAt: r.expiresAt ?? r.createdAt,
      createdAt: r.createdAt,
    })),
  );
}
