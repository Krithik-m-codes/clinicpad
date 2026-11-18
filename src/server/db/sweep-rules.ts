/**
 * Which tenants in a DEVELOPMENT database are leftovers of aborted test runs. Pure; the script that deletes
 * them (sweep-test-tenants.ts) refuses to run against anything but a local database.
 */

/** RFC 2606 reserves example.com: no real user can have an address there. Tests use it for every user. */
export const TEST_EMAIL_DOMAIN = "@example.com";

/** Never swept, whatever its members (the demo seed re-creates it anyway). */
export const PROTECTED_SLUGS: readonly string[] = ["demo-clinic"];

export type TenantFacts = { id: string; slug: string; createdAt: Date; memberEmails: string[] };

/** A test tenant: older than the threshold, not protected, and every member (if any) has a test address. */
export function isLeakedTestTenant(t: TenantFacts, now: Date, minAgeMinutes: number): boolean {
  if (PROTECTED_SLUGS.includes(t.slug)) return false;
  if (now.getTime() - t.createdAt.getTime() < minAgeMinutes * 60_000) return false;
  return t.memberEmails.every((email) => email.toLowerCase().endsWith(TEST_EMAIL_DOMAIN));
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "postgres"]);

/** True only for a database on this machine or the docker-compose service. */
export function isLocalDatabaseUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    return LOCAL_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}
