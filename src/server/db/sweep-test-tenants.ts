import { pathToFileURL } from "node:url";
import { inArray, sql } from "drizzle-orm";
import { adminDb } from "@/server/db/admin";
import { tenants } from "@/server/db/schema";
import { isLeakedTestTenant, isLocalDatabaseUrl, TEST_EMAIL_DOMAIN, type TenantFacts } from "./sweep-rules";

export type SweepReport = { tenants: { id: string; slug: string }[]; users: number; applied: boolean };

/**
 * Lists (and with apply, deletes) tenants left behind by aborted test runs, then test users that belong to no
 * clinic. Deleting a tenant row erases its records through the cascades (tenant_is_erased, ADR-0023).
 */
export async function sweepTestTenants(opts: { apply: boolean; olderThanMinutes: number; now?: Date }): Promise<SweepReport> {
  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getTime() - opts.olderThanMinutes * 60_000);
  const rows = await adminDb.execute<{ id: string; slug: string; created_at: Date | string; emails: string[] | null }>(sql`
    select t.id::text as id, t.slug, t.created_at, array_remove(array_agg(u.email::text), null) as emails
      from tenants t
      left join memberships m on m.tenant_id = t.id
      left join users u on u.id = m.user_id
     group by t.id, t.slug, t.created_at`);
  const facts: TenantFacts[] = rows.map((r) => ({
    id: r.id,
    slug: r.slug,
    createdAt: new Date(r.created_at),
    memberEmails: r.emails ?? [],
  }));
  const leaked = facts.filter((t) => isLeakedTestTenant(t, now, opts.olderThanMinutes));
  const pattern = `%${TEST_EMAIL_DOMAIN}`;

  if (!opts.apply) {
    const [count] = await adminDb.execute<{ n: number }>(sql`
      select count(*)::int as n from users u
       where lower(u.email) like ${pattern} and u.created_at < ${cutoff.toISOString()}::timestamptz
         and not exists (select 1 from memberships m where m.user_id = u.id)`);
    return { tenants: leaked.map(({ id, slug }) => ({ id, slug })), users: count.n, applied: false };
  }

  for (let i = 0; i < leaked.length; i += 100) {
    await adminDb.delete(tenants).where(inArray(tenants.id, leaked.slice(i, i + 100).map((t) => t.id)));
  }
  const removed = await adminDb.execute<{ id: string }>(sql`
    delete from users u
     where lower(u.email) like ${pattern} and u.created_at < ${cutoff.toISOString()}::timestamptz
       and not exists (select 1 from memberships m where m.user_id = u.id)
    returning u.id::text as id`);
  return { tenants: leaked.map(({ id, slug }) => ({ id, slug })), users: removed.length, applied: true };
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const older = args.find((a) => a.startsWith("--older-than="));
  const olderThanMinutes = older ? Number(older.split("=")[1]) : 60;
  const url = process.env.ADMIN_DATABASE_URL ?? process.env.DIRECT_URL ?? process.env.DATABASE_URL;
  if (!Number.isInteger(olderThanMinutes) || olderThanMinutes < 10) {
    console.error("--older-than must be a whole number of minutes, at least 10.");
    process.exit(1);
  }
  if (process.env.NODE_ENV === "production" || !isLocalDatabaseUrl(url)) {
    console.error("Refusing to sweep: this script only runs against a local development database.");
    process.exit(1);
  }
  sweepTestTenants({ apply, olderThanMinutes })
    .then((report) => {
      console.log(`${report.applied ? "Deleted" : "Would delete"} ${report.tenants.length} test tenants and ${report.users} test users.`);
      for (const t of report.tenants.slice(0, 50)) console.log(`  ${t.slug}`);
      if (!report.applied) console.log("Run again with --apply to delete them.");
      process.exit(0);
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.name : typeof error);
      process.exit(1);
    });
}
