import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { adminDb } from "@/server/db/admin";

/**
 * Policies on tenant tables that are NOT scoped by app.tenant_id, as "table.policy" -> reason. Keep this list
 * short and justified: every other policy on a table with a tenant_id must compare it with the session tenant.
 */
const NON_TENANT_POLICIES: Record<string, string> = {};

type TableRow = { table_name: string; rls: boolean; forced: boolean };
type PolicyRow = { table_name: string; policy: string; cmd: string; qual: string | null; with_check: string | null };

async function tenantTables(): Promise<TableRow[]> {
  return adminDb.execute<TableRow>(sql`
    select c.relname::text as table_name, c.relrowsecurity as rls, c.relforcerowsecurity as forced
      from pg_class c
     where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
       and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped)
     order by 1`);
}

async function policies(): Promise<PolicyRow[]> {
  return adminDb.execute<PolicyRow>(sql`
    select tablename::text as table_name, policyname::text as policy, cmd::text as cmd, qual, with_check
      from pg_policies where schemaname = 'public' order by 1, 2`);
}

/** Every expression the policy has (USING and WITH CHECK, each separately) must name the session tenant. */
const scoped = (p: PolicyRow) =>
  [p.qual, p.with_check].filter((e): e is string => e !== null).every((e) => e.includes("app.tenant_id")) &&
  (p.qual !== null || p.with_check !== null);

describe("row-level security across the whole schema", () => {
  it("sees the known tenant tables, so it cannot pass vacuously", async () => {
    const names = (await tenantTables()).map((r) => r.table_name);
    expect(names).toEqual(
      expect.arrayContaining([
        "audit_events",
        "clinic_assets",
        "medicine_favourites",
        "patients",
        "prescription_items",
        "prescription_outputs",
        "prescriptions",
        "tenant_counters",
        "tenant_medicines",
        "visits",
      ]),
    );
  });

  it("enables and forces RLS on every table that has a tenant_id", async () => {
    const weak = (await tenantTables()).filter((r) => !r.rls || !r.forced).map((r) => r.table_name);
    expect(weak).toEqual([]);
  });

  it("gives every tenant table a policy and scopes every policy by app.tenant_id", async () => {
    const tables = (await tenantTables()).map((r) => r.table_name);
    const rows = await policies();
    expect(tables.filter((t) => !rows.some((p) => p.table_name === t))).toEqual([]);
    const unscoped = rows
      .filter((p) => tables.includes(p.table_name) && !scoped(p))
      .map((p) => `${p.table_name}.${p.policy}`)
      .filter((key) => !Object.hasOwn(NON_TENANT_POLICIES, key));
    expect(unscoped).toEqual([]);
  });

  it("keeps every allow-listed exception real (no stale entries)", async () => {
    const keys = (await policies()).map((p) => `${p.table_name}.${p.policy}`);
    expect(Object.keys(NON_TENANT_POLICIES).filter((key) => !keys.includes(key))).toEqual([]);
  });

  it("keeps tenants itself forced and scoped to the session's tenant", async () => {
    const [table] = await adminDb.execute<TableRow>(sql`
      select relname::text as table_name, relrowsecurity as rls, relforcerowsecurity as forced
        from pg_class where oid = 'public.tenants'::regclass`);
    expect(table).toMatchObject({ rls: true, forced: true });
    const rows = (await policies()).filter((p) => p.table_name === "tenants");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every(scoped)).toBe(true);
  });

  it("never grants the application role TRUNCATE on any table, or anything on users", async () => {
    const [row] = await adminDb.execute<{ truncatable: string[] | null; users_select: boolean }>(sql`
      select (select array_agg(c.relname::text order by c.relname) from pg_class c
               where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
                 and has_table_privilege('clinicpad_app', c.oid, 'TRUNCATE')) as truncatable,
             has_table_privilege('clinicpad_app', 'public.users', 'SELECT') as users_select`);
    expect(row.truncatable).toBeNull();
    expect(row.users_select).toBe(false);
  });

  it("keeps the global catalogue read-only for the application role", async () => {
    for (const table of ["global_medicines", "global_clinical_terms"]) {
      const [row] = await adminDb.execute<{ sel: boolean; ins: boolean; upd: boolean; del: boolean; forced: boolean }>(sql`
        select has_table_privilege('clinicpad_app', ${`public.${table}`}, 'SELECT') as sel,
               has_table_privilege('clinicpad_app', ${`public.${table}`}, 'INSERT') as ins,
               has_table_privilege('clinicpad_app', ${`public.${table}`}, 'UPDATE') as upd,
               has_table_privilege('clinicpad_app', ${`public.${table}`}, 'DELETE') as del,
               (select relforcerowsecurity from pg_class where oid = ${`public.${table}`}::regclass) as forced`);
      expect(row, table).toEqual({ sel: true, ins: false, upd: false, del: false, forced: true });
    }
  });
});
