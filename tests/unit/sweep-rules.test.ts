import { describe, expect, it } from "vitest";
import { isLeakedTestTenant, isLocalDatabaseUrl, type TenantFacts } from "@/server/db/sweep-rules";

const now = new Date("2026-11-17T12:00:00.000Z");
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000);
const tenant = (overrides: Partial<TenantFacts> = {}): TenantFacts => ({
  id: "t",
  slug: "t-label-1763380000000-abc",
  createdAt: hoursAgo(3),
  memberEmails: [],
  ...overrides,
});

describe("isLeakedTestTenant", () => {
  it("sweeps an old tenant with no members (integration-test tenants before Plan 1D)", () => {
    expect(isLeakedTestTenant(tenant(), now, 60)).toBe(true);
  });

  it("sweeps an old tenant whose members all use the reserved example.com domain", () => {
    expect(isLeakedTestTenant(tenant({ memberEmails: ["pat-1@example.com", "x@EXAMPLE.COM"] }), now, 60)).toBe(true);
  });

  it("keeps a tenant with any real member", () => {
    expect(isLeakedTestTenant(tenant({ memberEmails: ["pat-1@example.com", "doctor@clinic.in"] }), now, 60)).toBe(false);
  });

  it("keeps the demo clinic whatever its members", () => {
    expect(isLeakedTestTenant(tenant({ slug: "demo-clinic" }), now, 60)).toBe(false);
  });

  it("keeps anything younger than the threshold, so a running test suite is never disturbed", () => {
    expect(isLeakedTestTenant(tenant({ createdAt: hoursAgo(0.5) }), now, 60)).toBe(false);
  });

  it("does not treat look-alike domains as test domains", () => {
    expect(isLeakedTestTenant(tenant({ memberEmails: ["a@example.com.evil.in"] }), now, 60)).toBe(false);
    expect(isLeakedTestTenant(tenant({ memberEmails: ["a@notexample.com"] }), now, 60)).toBe(false);
  });
});

describe("isLocalDatabaseUrl", () => {
  it.each([
    ["postgresql://clinicpad:clinicpad@localhost:5432/clinicpad", true],
    ["postgresql://u:p@127.0.0.1:5432/db", true],
    ["postgresql://u:p@[::1]:5432/db", true],
    ["postgresql://u:p@postgres:5432/db", true],
    ["postgresql://u:p@db.abcd.supabase.co:5432/postgres", false],
    ["not a url", false],
    [undefined, false],
  ])("%s -> %s", (url, expected) => {
    expect(isLocalDatabaseUrl(url)).toBe(expected);
  });
});
