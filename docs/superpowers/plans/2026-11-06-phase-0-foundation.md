# ClinicPad Phase 0 — Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the copied prototype into a strict, multi-tenant, authenticated Next.js application with a Postgres schema, RLS isolation, an onboarding flow, an app shell, seed data, and CI — the foundation every later phase depends on.

**Architecture:** Split the web (server) and desktop (static/Tauri) builds. Use Drizzle + Postgres with `tenant_id` on every business table and RLS enforced by `app.tenant_id` set inside a transaction. Use Auth.js v5 credentials sessions carrying `userId`, `tenantId`, and `role`. Sign-up creates the tenant, clinic, branch, doctor, and owner membership atomically.

**Tech Stack:** Next.js 15.5, React 19, TypeScript strict, Tailwind v4, shadcn/ui, Postgres 16, Drizzle ORM, Auth.js v5, bcryptjs, Zod, Vitest, Playwright, Docker Compose.

**Spec:** `docs/superpowers/specs/2026-11-06-clinicpad-platform-design.md`

**Product context:** `docs/PRODUCT_SPEC.md`, `docs/ARCHITECTURE.md`, `docs/DATA_MODEL.md`

---

## Global Constraints

- Node.js 22+; npm only (commit `package-lock.json`).
- TypeScript strict; no `any`; no `@ts-ignore` without a linked issue.
- `NEXT_BUILD_TARGET=desktop` is the only switch that enables static export.
- Every business table has `tenant_id UUID NOT NULL`; RLS is enabled on all of them.
- `tenant_id` comes from the session, never from request input.
- Money is integer minor units (paise/cents) plus ISO currency.
- IDs are UUIDv7; human-facing numbers are per-tenant sequences.
- Timestamps are UTC; render in the tenant timezone (`Asia/Kolkata` default).
- Secrets live in `.env.local`; `.env.example` is committed, `.env.local` is not.
- Conventional commits; one logical change per commit.
- Run `npm run lint && npm run typecheck && npm run test` before every commit once the scripts exist.
- Do not add Phase 1+ features (prescriptions UI, templates, billing, WhatsApp) in this plan.

---

## Review Focus

These are the failure modes most likely to hurt a real clinic, even though no single task's happy-path test covers them. Each is pinned to a test in the task that owns the code.

1. **Missing or stale tenant context.** A session without a membership, or a pooled connection that loses `app.tenant_id`, must fail closed (zero rows / explicit redirect), never return another tenant's rows. → Task 7 and Task 8.
2. **Duplicate sign-up races.** Two requests with the same email or phone must produce a field-level error, not a 500 or a second tenant. → Task 9.
3. **Role changes do not take effect.** A user demoted from Owner must not keep owner powers in an old JWT. → Task 8.
4. **Non-India defaults leak into invoices and prescriptions.** A tenant in another timezone/currency must not be rendered with `Asia/Kolkata`/`INR` hard-coded. → Task 5 and Task 10.
5. **Destructive migrations.** A failed migration or seed must not leave a half-created tenant or drop data on re-run. → Task 6 and Task 11.

---

## File Structure

```
clinicpad/
├── .github/workflows/ci.yml          # CI: lint, typecheck, test, build
├── docker-compose.yml                # local Postgres
├── drizzle.config.ts                 # drizzle-kit config
├── drizzle/                          # generated SQL migrations
├── scripts/
│   ├── check-superpowers.ps1         # exists
│   └── verify-gate-0.mjs             # one-command gate check
├── src/
│   ├── app/
│   │   ├── (auth)/
│   │   │   ├── login/page.tsx
│   │   │   └── signup/page.tsx
│   │   ├── (app)/
│   │   │   ├── layout.tsx            # authenticated shell
│   │   │   ├── dashboard/page.tsx
│   │   │   ├── patients/page.tsx
│   │   │   └── settings/page.tsx
│   │   ├── api/
│   │   │   ├── auth/[...nextauth]/route.ts
│   │   │   └── health/route.ts
│   │   ├── layout.tsx                # root layout, metadata
│   │   └── page.tsx                  # redirects to dashboard/login
│   ├── auth.ts                       # Auth.js config
│   ├── middleware.ts                 # route protection
│   ├── components/
│   │   ├── app-shell/sidebar.tsx
│   │   └── ui/*                      # existing shadcn primitives
│   ├── lib/
│   │   ├── domain/
│   │   │   ├── money.ts
│   │   │   ├── ids.ts
│   │   │   └── result.ts
│   │   └── utils.ts                  # exists
│   ├── server/
│   │   ├── auth/
│   │   │   ├── password.ts
│   │   │   ├── session.ts
│   │   │   └── actions.ts
│   │   ├── db/
│   │   │   ├── client.ts
│   │   │   ├── tenant.ts
│   │   │   ├── seed.ts
│   │   │   └── schema/
│   │   │       ├── index.ts
│   │   │       ├── enums.ts
│   │   │       ├── tenancy.ts
│   │   │       └── clinical.ts
│   │   └── validation/
│   │       └── onboarding.ts
│   └── types/next-auth.d.ts
├── tests/
│   ├── setup.ts
│   ├── unit/money.test.ts
│   ├── unit/ids.test.ts
│   ├── integration/rls.test.ts
│   └── e2e/smoke.spec.ts
├── vitest.config.ts
├── playwright.config.ts
└── .env.example
```

**Boundaries:** `src/server/**` is server-only. `src/lib/domain/**` is pure and environment-free. Route files parse input, authorize, call a service, and render. `src/app/(app)/**` never imports the raw db client; it uses `withTenant` through a server module.

---

## Task 1: Baseline cleanup, rebrand, and first commit

**Files:**
- Delete: `test.txt`
- Modify: `package.json`, `src/app/layout.tsx`, `.gitignore`, `README.md`
- Keep: `.env.example`, `docs/**`, `scripts/check-superpowers.ps1`

**Interfaces:**
- Consumes: nothing.
- Produces: a clean git baseline named `clinicpad` with no build artefacts tracked.

- [ ] **Step 1: Install dependencies and remove the scratch file**

```powershell
cd E:\Shubpy\projects\clinicpad
npm install --no-audit --no-fund
if (Test-Path .\test.txt) { Remove-Item .\test.txt }
```

- [ ] **Step 2: Rebrand `package.json`**

Set these fields (leave the rest unchanged):

```json
{
  "name": "clinicpad",
  "version": "0.1.0",
  "description": "Prescription-first clinic operating system with bring-your-own-pad templates.",
  "private": true
}
```

- [ ] **Step 3: Replace the root metadata**

Edit `src/app/layout.tsx` so the metadata block is exactly:

```tsx
export const metadata: Metadata = {
  title: "ClinicPad — Your pad, digitised",
  description:
    "Prescription-first clinic software that uses your own pad and works when the internet doesn't.",
  applicationName: "ClinicPad",
};
```

Keep the existing font setup and providers for now. The hard-coded doctor header is removed in Phase 1, not here.

- [ ] **Step 4: Fix `.gitignore`**

Ensure it contains these lines (add the exception — without it `.env.example` is ignored by the existing `.env*` rule):

```gitignore
# env files
.env*
!.env.example

# build and test output
/src-tauri/target/
/src/.dist/
coverage/
playwright-report/
test-results/
```

Also remove the `test.txt` line, since the file is gone.

- [ ] **Step 5: Verify branding and ignore rules**

```powershell
npm pkg get name
git check-ignore .env.example
```

Expected: `"clinicpad"` and no output from `git check-ignore` (exit code 1 means not ignored).

- [ ] **Step 6: Initialize git and commit**

```powershell
git init
git add .
git commit -m "chore: initialize ClinicPad from prescription prototype"
```

- [ ] **Step 7: Confirm nothing generated was committed**

```powershell
git ls-files | Select-String -Pattern "node_modules|\.next|src/\.dist|src-tauri/target|\.env\.local"
```

Expected: no matches.

---

## Task 2: Strict dual build (web + desktop)

**Files:**
- Modify: `next.config.ts`, `package.json`, `src-tauri/tauri.conf.json`
- Create: `scripts/verify-build-config.mjs`
- Test: `scripts/verify-build-config.mjs` (run directly)

**Interfaces:**
- Consumes: Task 1's `package.json`.
- Produces: `npm run build:web` (server) and `npm run build:desktop` (static export) with strict type/lint checks.

- [ ] **Step 1: Write the failing config check**

Create `scripts/verify-build-config.mjs`:

```js
import { readFileSync } from "node:fs";

const nextConfig = readFileSync(new URL("../next.config.ts", import.meta.url), "utf8");
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

const checks = [
  ["desktop switch exists", nextConfig.includes("NEXT_BUILD_TARGET")],
  ["static export is conditional", nextConfig.includes("isDesktop")],
  ["build errors are strict", !nextConfig.includes("ignoreBuildErrors: true")],
  ["lint errors are strict", !nextConfig.includes("ignoreDuringBuilds: true")],
  ["web build script exists", typeof pkg.scripts?.["build:web"] === "string"],
  ["desktop build script exists", typeof pkg.scripts?.["build:desktop"] === "string"],
];

let failed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
  if (!ok) failed++;
}
process.exit(failed === 0 ? 0 : 1);
```

- [ ] **Step 2: Run it to verify it fails**

```powershell
node .\scripts\verify-build-config.mjs
```

Expected: FAIL lines for the missing switch and scripts; exit code 1.

- [ ] **Step 3: Rewrite `next.config.ts`**

```ts
import type { NextConfig } from "next";

const isDesktop = process.env.NEXT_BUILD_TARGET === "desktop";

const nextConfig: NextConfig = {
  ...(isDesktop
    ? {
        output: "export" as const,
        distDir: "src/.dist",
        assetPrefix: "./",
        images: { unoptimized: true },
      }
    : {}),
  typescript: { ignoreBuildErrors: false },
  eslint: { ignoreDuringBuilds: false },
};

export default nextConfig;
```

- [ ] **Step 4: Add scripts and the missing dependency**

```powershell
npm install @radix-ui/react-tabs --no-audit --no-fund
npm install -D cross-env --no-audit --no-fund
```

Set `package.json` scripts (merge with existing Tauri scripts):

```json
{
  "scripts": {
    "dev": "next dev --turbopack",
    "build": "next build",
    "build:web": "next build",
    "build:desktop": "cross-env NEXT_BUILD_TARGET=desktop next build",
    "start": "next start",
    "lint": "eslint",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:e2e": "playwright test",
    "tauri": "tauri",
    "tauri:build": "tauri build",
    "tauri:dev": "tauri dev",
    "tauri:debug-build": "tauri build -- --debug",
    "tauri:hard-clean-build": "cd src-tauri && cargo clean && tauri build"
  }
}
```

- [ ] **Step 5: Point Tauri at the desktop build**

In `src-tauri/tauri.conf.json`:

```json
{
  "productName": "ClinicPad",
  "identifier": "app.clinicpad.desktop",
  "build": {
    "frontendDist": "../src/.dist",
    "devUrl": "http://localhost:3000",
    "beforeDevCommand": "npm run dev",
    "beforeBuildCommand": "npm run build:desktop"
  }
}
```

Keep the rest of the file (window size, icons, bundle) unchanged.

- [ ] **Step 6: Run the config check and typecheck**

```powershell
node .\scripts\verify-build-config.mjs
npm run typecheck
```

Expected: all PASS; `tsc` exits 0. If a type error appears, fix the type — do not re-enable `ignoreBuildErrors`.

- [ ] **Step 7: Build both targets**

```powershell
npm run build:web
npm run build:desktop
```

Expected: both exit 0. If the web build fails because a route uses `window` at module scope, move that code into a client component or a `useEffect`.

- [ ] **Step 8: Commit**

```powershell
git add next.config.ts package.json package-lock.json src-tauri/tauri.conf.json scripts/verify-build-config.mjs
git commit -m "build: split web and desktop targets and enforce strict checks"
```

---

## Task 3: Test harness and domain primitives (TDD)

**Files:**
- Create: `vitest.config.ts`, `tests/setup.ts`, `tests/unit/money.test.ts`, `tests/unit/ids.test.ts`, `src/lib/domain/money.ts`, `src/lib/domain/ids.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: Task 2's scripts.
- Produces: `Money` helpers and `newId()` used by every later server module.

- [ ] **Step 1: Install test tooling**

```powershell
npm install -D vitest @vitejs/plugin-react jsdom @testing-library/react @testing-library/jest-dom uuidv7
```

- [ ] **Step 2: Add `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    exclude: ["tests/e2e/**"],
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
});
```

- [ ] **Step 3: Add `tests/setup.ts`**

```ts
import "@testing-library/jest-dom/vitest";
```

- [ ] **Step 4: Write the failing money tests**

Create `tests/unit/money.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { addMoney, formatMoney, money } from "@/lib/domain/money";

describe("money", () => {
  it("stores integer paise", () => {
    expect(money(1999).amount).toBe(1999);
  });

  it("rejects fractional minor units", () => {
    expect(() => money(19.99)).toThrow("integer minor units");
  });

  it("rejects negative amounts by default", () => {
    expect(() => money(-1)).toThrow("non-negative");
  });

  it("adds only matching currencies", () => {
    expect(addMoney(money(100), money(250))).toEqual({ amount: 350, currency: "INR" });
    expect(() => addMoney(money(100, "INR"), money(100, "USD"))).toThrow("currency mismatch");
  });

  it("formats paise as rupees", () => {
    expect(formatMoney(money(199900), "en-IN")).toContain("1,999");
  });
});
```

- [ ] **Step 5: Write the failing id tests**

Create `tests/unit/ids.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { newId } from "@/lib/domain/ids";

describe("newId", () => {
  it("returns a UUIDv7", () => {
    const id = newId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("is time-sortable", () => {
    const a = newId();
    const b = newId();
    expect(a < b).toBe(true);
  });
});
```

- [ ] **Step 6: Run tests to verify they fail**

```powershell
npm run test
```

Expected: FAIL — `Cannot find module '@/lib/domain/money'`.

- [ ] **Step 7: Implement `money.ts`**

```ts
export type Currency = "INR" | "USD" | "GBP" | "AED" | "SGD";

export type Money = {
  readonly amount: number;
  readonly currency: Currency;
};

export function money(amount: number, currency: Currency = "INR"): Money {
  if (!Number.isInteger(amount)) throw new Error("amount must be integer minor units");
  if (amount < 0) throw new Error("amount must be non-negative");
  return { amount, currency };
}

export function addMoney(a: Money, b: Money): Money {
  if (a.currency !== b.currency) throw new Error("currency mismatch");
  return money(a.amount + b.amount, a.currency);
}

export function formatMoney(value: Money, locale = "en-IN"): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: value.currency,
  }).format(value.amount / 100);
}
```

- [ ] **Step 8: Implement `ids.ts`**

```ts
import { uuidv7 } from "uuidv7";

export function newId(): string {
  return uuidv7();
}
```

- [ ] **Step 9: Run tests**

```powershell
npm run test
```

Expected: PASS (7 tests).

- [ ] **Step 10: Commit**

```powershell
git add vitest.config.ts tests src/lib/domain package.json package-lock.json
git commit -m "test: add vitest and money/id domain primitives"
```

---

## Task 4: Local Postgres, Drizzle, and health check

**Files:**
- Create: `docker-compose.yml`, `drizzle.config.ts`, `src/server/db/client.ts`, `src/server/db/schema/index.ts` (placeholder barrel), `src/app/api/health/route.ts`
- Modify: `.env.example` (add `DATABASE_URL`, `DIRECT_URL` — already present)
- Test: `tests/integration/health.test.ts`

**Interfaces:**
- Consumes: Task 3's test harness.
- Produces: `db` (Drizzle client), `GET /api/health`, and `npm run db:*` scripts.

- [ ] **Step 1: Write the failing health test**

Create `tests/integration/health.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

describe("database", () => {
  it("connects and answers select 1", async () => {
    const { db } = await import("@/server/db/client");
    const result = await db.execute(sql`select 1 as ok`);
    expect(Number(result[0]?.ok)).toBe(1);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```powershell
npm run test -- tests/integration/health.test.ts
```

Expected: FAIL — module or `DATABASE_URL` missing.

- [ ] **Step 3: Add `docker-compose.yml`**

```yaml
services:
  postgres:
    image: postgres:16-alpine
    container_name: clinicpad-postgres
    environment:
      POSTGRES_USER: clinicpad
      POSTGRES_PASSWORD: clinicpad
      POSTGRES_DB: clinicpad
    ports:
      - "5432:5432"
    volumes:
      - clinicpad_pg:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U clinicpad -d clinicpad"]
      interval: 5s
      timeout: 5s
      retries: 10

volumes:
  clinicpad_pg:
```

- [ ] **Step 4: Start Postgres and create `.env.local`**

```powershell
docker compose up -d
Copy-Item .env.example .env.local
```

Ensure `.env.local` contains:

```env
DATABASE_URL=postgresql://clinicpad:clinicpad@localhost:5432/clinicpad
DIRECT_URL=postgresql://clinicpad:clinicpad@localhost:5432/clinicpad
```

- [ ] **Step 5: Add `drizzle.config.ts`**

```ts
import "dotenv/config";
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/server/db/schema/index.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DIRECT_URL ?? process.env.DATABASE_URL ?? "",
  },
  strict: true,
  verbose: true,
});
```

Install the required packages:

```powershell
npm install drizzle-orm postgres dotenv
npm install -D drizzle-kit tsx
```

- [ ] **Step 6: Add the db client and schema barrel**

`src/server/db/client.ts`:

```ts
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");

const client = postgres(connectionString, { max: 10, prepare: false });

export const db = drizzle(client, { schema });
export type Database = typeof db;
```

`src/server/db/schema/index.ts`:

```ts
export * from "./enums";
export * from "./tenancy";
export * from "./clinical";
```

Create empty `enums.ts`, `tenancy.ts`, and `clinical.ts` files for now (they are filled in Tasks 5 and 6).

- [ ] **Step 7: Add the health route**

```ts
import { sql } from "drizzle-orm";
import { db } from "@/server/db/client";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await db.execute(sql`select 1`);
    return Response.json({ status: "ok", service: "clinicpad", time: new Date().toISOString() });
  } catch {
    return Response.json({ status: "error", service: "clinicpad" }, { status: 503 });
  }
}
```

- [ ] **Step 8: Add scripts**

```json
{
  "scripts": {
    "db:generate": "drizzle-kit generate",
    "db:migrate": "drizzle-kit migrate",
    "db:studio": "drizzle-kit studio",
    "db:seed": "tsx src/server/db/seed.ts"
  }
}
```

- [ ] **Step 9: Run the test**

```powershell
npm run test -- tests/integration/health.test.ts
```

Expected: PASS.

- [ ] **Step 10: Commit**

```powershell
git add docker-compose.yml drizzle.config.ts src/server/db src/app/api/health tests/integration/health.test.ts package.json package-lock.json
git commit -m "feat: add local postgres, drizzle client, and health check"
```

## Task 5: Tenancy schema (tenants, clinics, branches, users, memberships, doctors)

**Files:**
- Create: `src/server/db/schema/enums.ts`, `src/server/db/schema/tenancy.ts`
- Modify: `src/server/db/schema/index.ts`
- Test: `tests/integration/tenancy.test.ts`

**Interfaces:**
- Consumes: `db` and `newId()` from Tasks 3–4.
- Produces: tables and inferred types `Tenant`, `Clinic`, `Branch`, `User`, `Membership`, `Doctor`; enums `memberRole`, `memberStatus`, `tenantPlan`.

- [ ] **Step 1: Write the failing tenancy test**

Create `tests/integration/tenancy.test.ts`:

```ts
import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { adminDb } from "@/server/db/admin";
import { branches, clinics, memberships, tenants, users } from "@/server/db/schema";

const created: string[] = [];

afterAll(async () => {
  for (const id of created) {
    await adminDb.delete(tenants).where(eq(tenants.id, id));
  }
});

describe("tenancy schema", () => {
  it("persists non-India defaults per tenant", async () => {
    const [tenant] = await adminDb
      .insert(tenants)
      .values({ name: "Berlin Clinic", slug: `berlin-${Date.now()}`, region: "eu-central-1", plan: "solo" })
      .returning();
    created.push(tenant.id);

    const [clinic] = await adminDb
      .insert(clinics)
      .values({
        tenantId: tenant.id,
        name: "Berlin Clinic",
        timezone: "Europe/Berlin",
        currency: "EUR",
        country: "DE",
      })
      .returning();

    expect(clinic.timezone).toBe("Europe/Berlin");
    expect(clinic.currency).toBe("EUR");
  });

  it("rejects a duplicate membership for the same tenant and user", async () => {
    const suffix = Date.now();
    const [tenant] = await adminDb
      .insert(tenants)
      .values({ name: "Dup Clinic", slug: `dup-${suffix}` })
      .returning();
    created.push(tenant.id);

    const [user] = await adminDb
      .insert(users)
      .values({ email: `dup-${suffix}@example.com`, name: "Dup User" })
      .returning();

    await adminDb.insert(memberships).values({
      tenantId: tenant.id,
      userId: user.id,
      role: "owner",
      status: "active",
    });

    await expect(
      adminDb.insert(memberships).values({
        tenantId: tenant.id,
        userId: user.id,
        role: "doctor",
        status: "active",
      }),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```powershell
npm run test -- tests/integration/tenancy.test.ts
```

Expected: FAIL — `@/server/db/admin` and schema exports do not exist.

- [ ] **Step 3: Add the admin client**

The app role cannot insert a tenant before `app.tenant_id` exists. Tenant creation uses the admin connection, and only the signup service may call it.

`src/server/db/admin.ts`:

```ts
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const connectionString =
  process.env.ADMIN_DATABASE_URL ?? process.env.DIRECT_URL ?? process.env.DATABASE_URL;
if (!connectionString) throw new Error("ADMIN_DATABASE_URL, DIRECT_URL, or DATABASE_URL is required");

const adminClient = postgres(connectionString, { max: 3, prepare: false });

export const adminDb = drizzle(adminClient, { schema });
```

Add to `.env.example`:

```env
# Optional: defaults to DIRECT_URL. Used only for tenant creation, migrations, and seed.
ADMIN_DATABASE_URL=
```

- [ ] **Step 4: Write `enums.ts`**

```ts
import { pgEnum } from "drizzle-orm/pg-core";

export const tenantPlan = pgEnum("tenant_plan", ["free", "solo", "clinic", "chain"]);
export const memberRole = pgEnum("member_role", [
  "owner",
  "doctor",
  "reception",
  "nurse",
  "accountant",
  "pharmacist",
]);
export const memberStatus = pgEnum("member_status", ["invited", "active", "disabled"]);
```

- [ ] **Step 5: Write `tenancy.ts`**

```ts
import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { uuidv7 } from "uuidv7";
import { memberRole, memberStatus, tenantPlan } from "./enums";

const pk = () => uuid("id").primaryKey().$defaultFn(() => uuidv7());
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const tenants = pgTable(
  "tenants",
  {
    id: pk(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    region: text("region").notNull().default("ap-south-1"),
    plan: tenantPlan("plan").notNull().default("free"),
    trialEndsAt: timestamp("trial_ends_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [unique("tenants_slug_unique").on(t.slug)],
);

export const clinics = pgTable(
  "clinics",
  {
    id: pk(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    addressLine1: text("address_line1"),
    city: text("city"),
    state: text("state"),
    pincode: text("pincode"),
    country: text("country").notNull().default("IN"),
    timezone: text("timezone").notNull().default("Asia/Kolkata"),
    currency: text("currency").notNull().default("INR"),
    logoUrl: text("logo_url"),
    createdAt: createdAt(),
  },
  (t) => [index("clinics_tenant_idx").on(t.tenantId)],
);

export const branches = pgTable(
  "branches",
  {
    id: pk(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
    clinicId: uuid("clinic_id").notNull().references(() => clinics.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    address: text("address"),
    phone: text("phone"),
    isPrimary: boolean("is_primary").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [index("branches_tenant_idx").on(t.tenantId), index("branches_clinic_idx").on(t.clinicId)],
);

export const users = pgTable(
  "users",
  {
    id: pk(),
    email: text("email").notNull(),
    phone: text("phone"),
    name: text("name").notNull(),
    passwordHash: text("password_hash"),
    emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
    isPlatformAdmin: boolean("is_platform_admin").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [unique("users_email_unique").on(t.email), unique("users_phone_unique").on(t.phone)],
);

export const memberships = pgTable(
  "memberships",
  {
    id: pk(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    role: memberRole("role").notNull(),
    status: memberStatus("status").notNull().default("active"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("memberships_tenant_user_unique").on(t.tenantId, t.userId),
    index("memberships_user_idx").on(t.userId),
  ],
);

export const doctors = pgTable(
  "doctors",
  {
    id: pk(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    primaryBranchId: uuid("primary_branch_id").references(() => branches.id, { onDelete: "set null" }),
    regNo: text("reg_no"),
    qualifications: text("qualifications"),
    specialties: text("specialties").array(),
    signatureUrl: text("signature_url"),
    stampUrl: text("stamp_url"),
    consultationFeePaise: integer("consultation_fee_paise").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index("doctors_tenant_idx").on(t.tenantId), index("doctors_user_idx").on(t.userId)],
);
```

- [ ] **Step 6: Export the schema and run the tests**

```typescript
// src/server/db/schema/index.ts
export * from "./enums";
export * from "./tenancy";
export * from "./clinical";
```

`clinical.ts` is still empty; create it with `export {};` if TypeScript complains.

```powershell
npm run test -- tests/integration/tenancy.test.ts
```

Expected: PASS. If Postgres rejects `text("specialties").array()`, use `text("specialties").array().$type<string[]>()` and regenerate.

- [ ] **Step 7: Commit**

```powershell
git add src/server/db tests/integration/tenancy.test.ts .env.example
git commit -m "feat: add tenancy schema and admin client"
```

---

## Task 6: Clinical schema and first migration

**Files:**
- Create: `src/server/db/schema/clinical.ts`
- Test: `tests/integration/clinical.test.ts`
- Migration output: `drizzle/0000_*.sql`

**Interfaces:**
- Consumes: tenancy tables and enums.
- Produces: `patients`, `visits`, `prescriptions`, `prescriptionItems`, `templates`, `templateVersions`, `auditEvents` and their inferred types.

- [ ] **Step 1: Write the failing clinical test**

Create `tests/integration/clinical.test.ts`:

```ts
import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { adminDb } from "@/server/db/admin";
import { patients, prescriptions, prescriptionItems, tenants, visits } from "@/server/db/schema";

let tenantId = "";

afterAll(async () => {
  if (tenantId) await adminDb.delete(tenants).where(eq(tenants.id, tenantId));
});

describe("clinical schema", () => {
  it("links patient → visit → prescription → items", async () => {
    const suffix = Date.now();
    const [tenant] = await adminDb
      .insert(tenants)
      .values({ name: "Clinical Test", slug: `clinical-${suffix}` })
      .returning();
    tenantId = tenant.id;

    const [patient] = await adminDb
      .insert(patients)
      .values({ tenantId, name: "Asha Rao", phone: `9${suffix}` })
      .returning();

    const [visit] = await adminDb
      .insert(visits)
      .values({ tenantId, patientId: patient.id, status: "draft" })
      .returning();

    const [rx] = await adminDb
      .insert(prescriptions)
      .values({ tenantId, visitId: visit.id, rxNo: 1, version: 1, status: "draft" })
      .returning();

    await adminDb.insert(prescriptionItems).values({
      tenantId,
      prescriptionId: rx.id,
      sortOrder: 0,
      drugName: "Paracetamol",
      dose: "500 mg",
    });

    const items = await adminDb
      .select()
      .from(prescriptionItems)
      .where(eq(prescriptionItems.prescriptionId, rx.id));

    expect(items).toHaveLength(1);
    expect(items[0].drugName).toBe("Paracetamol");
  });

  it("rejects duplicate rx number and version in a tenant", async () => {
    const suffix = Date.now();
    const [tenant] = await adminDb
      .insert(tenants)
      .values({ name: "Rx Unique", slug: `rx-${suffix}` })
      .returning();

    const [patient] = await adminDb
      .insert(patients)
      .values({ tenantId: tenant.id, name: "Test Patient" })
      .returning();
    const [visit] = await adminDb
      .insert(visits)
      .values({ tenantId: tenant.id, patientId: patient.id, status: "draft" })
      .returning();

    await adminDb.insert(prescriptions).values({
      tenantId: tenant.id,
      visitId: visit.id,
      rxNo: 41,
      version: 1,
      status: "draft",
    });

    await expect(
      adminDb.insert(prescriptions).values({
        tenantId: tenant.id,
        visitId: visit.id,
        rxNo: 41,
        version: 1,
        status: "draft",
      }),
    ).rejects.toThrow();

    await adminDb.delete(tenants).where(eq(tenants.id, tenant.id));
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```powershell
npm run test -- tests/integration/clinical.test.ts
```

Expected: FAIL — clinical tables are not exported or do not exist.

- [ ] **Step 3: Write `clinical.ts`**

```ts
import {
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { uuidv7 } from "uuidv7";
import { tenants } from "./tenancy";

const pk = () => uuid("id").primaryKey().$defaultFn(() => uuidv7());
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date());

export const patients = pgTable(
  "patients",
  {
    id: pk(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    phone: text("phone"),
    phoneNormalized: text("phone_normalized"),
    dob: date("dob"),
    gender: text("gender"),
    address: text("address"),
    abha: text("abha"),
    allergies: text("allergies").array(),
    conditions: text("conditions").array(),
    notes: text("notes"),
    createdBy: uuid("created_by"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    index("patients_tenant_name_idx").on(t.tenantId, t.name),
    index("patients_tenant_phone_idx").on(t.tenantId, t.phoneNormalized),
  ],
);

export const visits = pgTable(
  "visits",
  {
    id: pk(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
    patientId: uuid("patient_id").notNull().references(() => patients.id, { onDelete: "restrict" }),
    doctorId: uuid("doctor_id"),
    branchId: uuid("branch_id"),
    status: text("status").notNull().default("draft"),
    visitType: text("visit_type").notNull().default("new"),
    chiefComplaint: text("chief_complaint"),
    vitals: jsonb("vitals").$type<Record<string, string | number>>(),
    diagnosis: text("diagnosis").array(),
    advice: text("advice"),
    followUpDate: date("follow_up_date"),
    finalizedAt: timestamp("finalized_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("visits_tenant_patient_idx").on(t.tenantId, t.patientId)],
);

export const prescriptions = pgTable(
  "prescriptions",
  {
    id: pk(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
    visitId: uuid("visit_id").notNull().references(() => visits.id, { onDelete: "cascade" }),
    rxNo: integer("rx_no").notNull(),
    version: integer("version").notNull().default(1),
    status: text("status").notNull().default("draft"),
    templateVersionId: uuid("template_version_id"),
    pdfUrl: text("pdf_url"),
    finalizedAt: timestamp("finalized_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    unique("prescriptions_tenant_rx_version_unique").on(t.tenantId, t.rxNo, t.version),
    index("prescriptions_visit_idx").on(t.visitId),
  ],
);

export const prescriptionItems = pgTable(
  "prescription_items",
  {
    id: pk(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
    prescriptionId: uuid("prescription_id")
      .notNull()
      .references(() => prescriptions.id, { onDelete: "cascade" }),
    sortOrder: integer("sort_order").notNull().default(0),
    drugName: text("drug_name").notNull(),
    strength: text("strength"),
    form: text("form"),
    route: text("route"),
    dose: text("dose"),
    timing: text("timing"),
    foodRelation: text("food_relation"),
    durationDays: integer("duration_days"),
    remarks: text("remarks"),
    createdAt: createdAt(),
  },
  (t) => [index("rx_items_prescription_idx").on(t.prescriptionId)],
);

export const templates = pgTable(
  "templates",
  {
    id: pk(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    kind: text("kind").notNull().default("html"),
    status: text("status").notNull().default("draft"),
    createdAt: createdAt(),
  },
  (t) => [index("templates_tenant_idx").on(t.tenantId)],
);

export const templateVersions = pgTable(
  "template_versions",
  {
    id: pk(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
    templateId: uuid("template_id").notNull().references(() => templates.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    fileKey: text("file_key"),
    mapping: jsonb("mapping").$type<Record<string, string>>(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [unique("template_versions_template_version_unique").on(t.templateId, t.version)],
);

export const auditEvents = pgTable(
  "audit_events",
  {
    id: pk(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
    actorUserId: uuid("actor_user_id"),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id"),
    before: jsonb("before"),
    after: jsonb("after"),
    ip: text("ip"),
    userAgent: text("user_agent"),
    createdAt: createdAt(),
  },
  (t) => [index("audit_tenant_created_idx").on(t.tenantId, t.createdAt)],
);
```

- [ ] **Step 4: Generate the migration**

```powershell
npm run db:generate
```

Expected: a new `drizzle/0000_*.sql` and `drizzle/meta/*` journal. Read the SQL and confirm every table has `tenant_id` except `tenants` and `users`.

- [ ] **Step 5: Apply the migration**

```powershell
npm run db:migrate
```

Expected: exits 0. Verify:

```powershell
docker compose exec postgres psql -U clinicpad -d clinicpad -c "\dt"
```

Expected: `tenants`, `clinics`, `branches`, `users`, `memberships`, `doctors`, `patients`, `visits`, `prescriptions`, `prescription_items`, `templates`, `template_versions`, `audit_events`.

- [ ] **Step 6: Run the tests**

```powershell
npm run test -- tests/integration/clinical.test.ts
```

Expected: PASS (2 tests).

- [ ] **Step 7: Commit**

```powershell
git add src/server/db/schema/clinical.ts drizzle tests/integration/clinical.test.ts
git commit -m "feat: add clinical schema and initial migration"
```

---

## Task 7: RLS policies, tenant-scoped client, and isolation tests

**Files:**
- Create: `src/server/db/tenant.ts`, `drizzle/0001_rls.sql` (via custom migration), `tests/integration/rls.test.ts`
- Modify: `.env.example`, `.env.local` (local only)

**Interfaces:**
- Consumes: all tables from Tasks 5–6.
- Produces: `withTenant(tenantId, fn)`; database roles `clinicpad` (admin/migrator) and `clinicpad_app` (runtime).

- [ ] **Step 1: Write the failing isolation test**

Create `tests/integration/rls.test.ts`:

```ts
import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { adminDb } from "@/server/db/admin";
import { withTenant } from "@/server/db/tenant";
import { patients, tenants } from "@/server/db/schema";

let tenantA = "";
let tenantB = "";

afterAll(async () => {
  if (tenantA) await adminDb.delete(tenants).where(eq(tenants.id, tenantA));
  if (tenantB) await adminDb.delete(tenants).where(eq(tenants.id, tenantB));
});

describe("row level security", () => {
  it("isolates reads and writes by tenant", async () => {
    const suffix = Date.now();
    const [a] = await adminDb.insert(tenants).values({ name: "A", slug: `rls-a-${suffix}` }).returning();
    const [b] = await adminDb.insert(tenants).values({ name: "B", slug: `rls-b-${suffix}` }).returning();
    tenantA = a.id;
    tenantB = b.id;

    await withTenant(a.id, (tx) =>
      tx.insert(patients).values({ tenantId: a.id, name: "Patient A" }),
    );

    const bRows = await withTenant(b.id, (tx) => tx.select().from(patients));
    expect(bRows).toHaveLength(0);

    await expect(
      withTenant(b.id, (tx) => tx.insert(patients).values({ tenantId: a.id, name: "Leak" })),
    ).rejects.toThrow();

    const aRows = await withTenant(a.id, (tx) => tx.select().from(patients));
    expect(aRows.map((r) => r.name)).toEqual(["Patient A"]);
  });

  it("fails closed when no tenant is set", async () => {
    const { db } = await import("@/server/db/client");
    const rows = await db.select().from(patients);
    expect(rows).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```powershell
npm run test -- tests/integration/rls.test.ts
```

Expected: FAIL — `withTenant` missing, or the second test returns all patient rows.

- [ ] **Step 3: Add the app role and change the local runtime URL**

Update `docker-compose.yml` to initialize the role on first boot by adding a volume mount is overkill; run the SQL manually after the first migration (the RLS migration creates it).

In `.env.local`, set:

```env
# Runtime app role (non-superuser, subject to RLS)
DATABASE_URL=postgresql://clinicpad_app:clinicpad_app@localhost:5432/clinicpad
# Migrations, seed, and tenant creation
DIRECT_URL=postgresql://clinicpad:clinicpad@localhost:5432/clinicpad
```

Update `.env.example` with the same two-role explanation.

- [ ] **Step 4: Create a custom migration**

```powershell
npx drizzle-kit generate --custom --name=rls
```

Expected: a new empty `drizzle/0001_rls.sql`. Paste:

```sql
-- Runtime role (local/dev). In Supabase, use the authenticated role instead.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'clinicpad_app') then
    create role clinicpad_app login password 'clinicpad_app';
  end if;
end $$;

grant usage on schema public to clinicpad_app;
grant select, insert, update, delete on all tables in schema public to clinicpad_app;
grant usage, select on all sequences in schema public to clinicpad_app;

alter default privileges in schema public
  grant select, insert, update, delete on tables to clinicpad_app;
alter default privileges in schema public
  grant usage, select on sequences to clinicpad_app;

-- Enable and force RLS on every tenant-owned table.
do $$
declare
  t text;
begin
  foreach t in array array[
    'clinics','branches','memberships','doctors','patients','visits',
    'prescriptions','prescription_items','templates','template_versions','audit_events'
  ]
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
  end loop;
end $$;

-- Tenants: a session can see only its own tenant row.
create policy tenant_self on tenants
  for all
  using (id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- Standard tenant isolation for every tenant-owned table.
do $$
declare
  t text;
begin
  foreach t in array array[
    'clinics','branches','memberships','doctors','patients','visits',
    'prescriptions','prescription_items','templates','template_versions'
  ]
  loop
    execute format(
      'create policy tenant_isolation on %I for all using (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid) with check (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)',
      t
    );
  end loop;
end $$;

-- Audit is append-only: select + insert, never update/delete.
create policy audit_select on audit_events
  for select
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

create policy audit_insert on audit_events
  for insert
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

revoke update, delete on audit_events from clinicpad_app;
```

Apply:

```powershell
npm run db:migrate
```

- [ ] **Step 5: Implement `withTenant`**

```ts
import { sql } from "drizzle-orm";
import { db } from "./client";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function withTenant<T>(
  tenantId: string,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  if (!tenantId) throw new Error("tenantId is required");
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
    return fn(tx);
  });
}
```

- [ ] **Step 6: Run the isolation tests**

```powershell
npm run test -- tests/integration/rls.test.ts
```

Expected: PASS (2 tests). If the "fails closed" test fails, the runtime URL is still the superuser — fix `DATABASE_URL`, do not weaken RLS.

- [ ] **Step 7: Commit**

```powershell
git add drizzle/0001_rls.sql src/server/db/tenant.ts tests/integration/rls.test.ts .env.example
git commit -m "feat: enforce tenant isolation with RLS"
```

---

## Task 8: Authentication and session freshness

**Files:**
- Create: `src/auth.ts`, `src/app/api/auth/[...nextauth]/route.ts`, `src/server/auth/password.ts`, `src/server/auth/session.ts`, `src/middleware.ts`, `src/types/next-auth.d.ts`, `src/app/(auth)/login/page.tsx`, `tests/integration/auth.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `users`, `memberships`, `db`.
- Produces: `auth()`, `requireSession()` returning `{ userId, tenantId, role }`, `hashPassword`, `verifyPassword`, `/login`.

- [ ] **Step 1: Install Auth.js and bcrypt**

```powershell
npm install next-auth@beta bcryptjs
npm install -D @types/bcryptjs
```

- [ ] **Step 2: Write the failing session test**

Create `tests/integration/auth.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "@/server/auth/password";

describe("password hashing", () => {
  it("verifies the correct password and rejects the wrong one", async () => {
    const hash = await hashPassword("ClinicPad!2026");
    expect(hash).not.toContain("ClinicPad!2026");
    expect(await verifyPassword("ClinicPad!2026", hash)).toBe(true);
    expect(await verifyPassword("wrong", hash)).toBe(false);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

```powershell
npm run test -- tests/integration/auth.test.ts
```

Expected: FAIL — module missing.

- [ ] **Step 4: Implement password helpers**

`src/server/auth/password.ts`:

```ts
import bcrypt from "bcryptjs";

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}
```

- [ ] **Step 5: Implement Auth.js config**

`src/auth.ts`:

```ts
import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/server/db/client";
import { memberships, users } from "@/server/db/schema";
import { verifyPassword } from "@/server/auth/password";

const credentialsSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

export const { handlers, auth, signIn, signOut } = NextAuth({
  session: { strategy: "jwt" },
  pages: { signIn: "/login" },
  providers: [
    Credentials({
      credentials: { email: {}, password: {} },
      async authorize(raw) {
        const parsed = credentialsSchema.safeParse(raw);
        if (!parsed.success) return null;

        const email = parsed.data.email.toLowerCase();
        const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
        if (!user?.passwordHash) return null;
        if (!(await verifyPassword(parsed.data.password, user.passwordHash))) return null;

        const [membership] = await db
          .select()
          .from(memberships)
          .where(eq(memberships.userId, user.id))
          .limit(1);

        return {
          id: user.id,
          email: user.email,
          name: user.name,
          tenantId: membership?.tenantId ?? null,
          role: membership?.role ?? null,
        };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.tenantId = user.tenantId ?? null;
        token.role = user.role ?? null;
      }
      // Re-read membership so role changes and deactivation take effect immediately.
      if (token.sub) {
        const [membership] = await db
          .select()
          .from(memberships)
          .where(eq(memberships.userId, token.sub))
          .limit(1);
        token.tenantId = membership?.tenantId ?? null;
        token.role = membership?.role ?? null;
      }
      return token;
    },
    async session({ session, token }) {
      session.user.id = token.sub ?? "";
      session.user.tenantId = (token.tenantId as string | null) ?? null;
      session.user.role = (token.role as string | null) ?? null;
      return session;
    },
  },
});
```

- [ ] **Step 6: Augment the types**

`src/types/next-auth.d.ts`:

```ts
import type { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface User {
    tenantId?: string | null;
    role?: string | null;
  }
  interface Session {
    user: {
      id: string;
      tenantId: string | null;
      role: string | null;
    } & DefaultSession["user"];
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    tenantId?: string | null;
    role?: string | null;
  }
}
```

- [ ] **Step 7: Add the route handler and session helper**

`src/app/api/auth/[...nextauth]/route.ts`:

```ts
import { handlers } from "@/auth";

export const { GET, POST } = handlers;
```

`src/server/auth/session.ts`:

```ts
import { redirect } from "next/navigation";
import { auth } from "@/auth";

export type SessionContext = {
  userId: string;
  tenantId: string;
  role: string;
};

export async function requireSession(): Promise<SessionContext> {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  if (!session.user.tenantId) redirect("/onboarding");
  return {
    userId: session.user.id,
    tenantId: session.user.tenantId,
    role: session.user.role ?? "reception",
  };
}
```

- [ ] **Step 8: Add middleware**

`src/middleware.ts`:

```ts
export { auth as middleware } from "@/auth";

export const config = {
  matcher: ["/dashboard/:path*", "/patients/:path*", "/settings/:path*"],
};
```

- [ ] **Step 9: Add the login page**

`src/app/(auth)/login/page.tsx` — a client component using `signIn`:

```tsx
"use client";

import { useState } from "react";
import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function LoginPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const form = new FormData(event.currentTarget);
    const result = await signIn("credentials", {
      email: String(form.get("email") ?? ""),
      password: String(form.get("password") ?? ""),
      redirect: false,
    });
    setPending(false);
    if (result?.error) {
      setError("Invalid email or password.");
      return;
    }
    router.push("/dashboard");
    router.refresh();
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Sign in to ClinicPad</h1>
        <p className="text-sm text-muted-foreground">Your pad. Your patients. Your clinic.</p>
      </div>
      <form onSubmit={onSubmit} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="email">Email</Label>
          <Input id="email" name="email" type="email" autoComplete="email" required />
        </div>
        <div className="space-y-2">
          <Label htmlFor="password">Password</Label>
          <Input id="password" name="password" type="password" autoComplete="current-password" required />
        </div>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <Button type="submit" className="w-full" disabled={pending}>
          {pending ? "Signing in…" : "Sign in"}
        </Button>
      </form>
      <p className="text-sm text-muted-foreground">
        New to ClinicPad? <a className="underline" href="/signup">Create a clinic</a>
      </p>
    </main>
  );
}
```

If `@/components/ui/input`, `label`, or `button` do not exist, create them with the existing shadcn style or use plain `<input>`/`<button>` with Tailwind classes. Do not add a second UI kit.

- [ ] **Step 10: Run tests and typecheck**

```powershell
npm run test -- tests/integration/auth.test.ts
npm run typecheck
```

Expected: PASS; typecheck exits 0.

- [ ] **Step 11: Commit**

```powershell
git add src/auth.ts src/app/api/auth src/server/auth src/types/next-auth.d.ts src/middleware.ts "src/app/(auth)/login" tests/integration/auth.test.ts package.json package-lock.json
git commit -m "feat: add Auth.js credentials sessions with tenant context"
```

## Task 9: Clinic sign-up (tenant + clinic + branch + doctor + owner)

**Files:**
- Create: `src/server/validation/onboarding.ts`, `src/server/auth/create-clinic.ts`, `src/server/auth/actions.ts`, `src/app/(auth)/signup/page.tsx`
- Test: `tests/integration/signup.test.ts`

**Interfaces:**
- Consumes: `adminDb`, `hashPassword`, all tenancy tables.
- Produces: `createClinicAccount(input): Promise<CreateClinicResult>`, `signupAction`, `/signup`.

- [ ] **Step 1: Write the failing sign-up tests**

Create `tests/integration/signup.test.ts`:

```ts
import { afterAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { adminDb } from "@/server/db/admin";
import { clinics, memberships, tenants, users } from "@/server/db/schema";
import { createClinicAccount } from "@/server/auth/create-clinic";

const createdTenants: string[] = [];
const createdUsers: string[] = [];

afterAll(async () => {
  if (createdTenants.length) await adminDb.delete(tenants).where(inArray(tenants.id, createdTenants));
  if (createdUsers.length) await adminDb.delete(users).where(inArray(users.id, createdUsers));
});

function input(suffix: string) {
  return {
    clinicName: `Sunrise Clinic ${suffix}`,
    doctorName: "Dr. Meera Shah",
    email: `meera-${suffix}@example.com`,
    phone: `98${suffix}`.slice(0, 12),
    password: "ClinicPad!2026",
    city: "Pune",
    country: "IN",
    timezone: "Asia/Kolkata",
    currency: "INR" as const,
  };
}

describe("createClinicAccount", () => {
  it("creates tenant, clinic, membership, and doctor atomically", async () => {
    const suffix = String(Date.now());
    const result = await createClinicAccount(input(suffix));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    createdTenants.push(result.tenantId);
    createdUsers.push(result.userId);

    const [membership] = await adminDb
      .select()
      .from(memberships)
      .where(eq(memberships.userId, result.userId));
    expect(membership.role).toBe("owner");

    const [clinic] = await adminDb.select().from(clinics).where(eq(clinics.tenantId, result.tenantId));
    expect(clinic.name).toContain("Sunrise Clinic");
    expect(clinic.timezone).toBe("Asia/Kolkata");
  });

  it("returns a field error for a duplicate email and creates nothing", async () => {
    const suffix = String(Date.now() + 1);
    const first = await createClinicAccount(input(suffix));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    createdTenants.push(first.tenantId);
    createdUsers.push(first.userId);

    const duplicate = await createClinicAccount(input(suffix));
    expect(duplicate).toEqual({ ok: false, field: "email", error: expect.any(String) });

    const rows = await adminDb.select().from(users).where(eq(users.email, input(suffix).email));
    expect(rows).toHaveLength(1);
  });

  it("rejects a short password before touching the database", async () => {
    const suffix = String(Date.now() + 2);
    const result = await createClinicAccount({ ...input(suffix), password: "short" });
    expect(result.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```powershell
npm run test -- tests/integration/signup.test.ts
```

Expected: FAIL — module missing.

- [ ] **Step 3: Add the validation schema**

`src/server/validation/onboarding.ts`:

```ts
import { z } from "zod";

export const onboardingSchema = z.object({
  clinicName: z.string().trim().min(2).max(120),
  doctorName: z.string().trim().min(2).max(120),
  email: z.string().trim().toLowerCase().email(),
  phone: z.string().trim().regex(/^[0-9]{10,15}$/, "Enter a valid phone number"),
  password: z.string().min(8, "Use at least 8 characters").max(72),
  city: z.string().trim().max(80).optional(),
  country: z.string().trim().length(2).default("IN"),
  timezone: z.string().trim().min(1).default("Asia/Kolkata"),
  currency: z.enum(["INR", "USD", "GBP", "AED", "SGD"]).default("INR"),
});

export type OnboardingInput = z.infer<typeof onboardingSchema>;
```

- [ ] **Step 4: Implement the transactional service**

`src/server/auth/create-clinic.ts`:

```ts
import { eq, or } from "drizzle-orm";
import { adminDb } from "@/server/db/admin";
import { branches, clinics, doctors, memberships, tenants, users } from "@/server/db/schema";
import { hashPassword } from "@/server/auth/password";
import { newId } from "@/lib/domain/ids";
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

function uniqueViolation(error: unknown): { constraint?: string } | null {
  if (typeof error !== "object" || error === null) return null;
  const candidate = error as { code?: string; constraint?: string };
  return candidate.code === "23505" ? candidate : null;
}

export async function createClinicAccount(raw: OnboardingInput): Promise<CreateClinicResult> {
  const parsed = onboardingSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, field: String(issue.path[0] ?? "form"), error: issue.message };
  }
  const input = parsed.data;
  const phone = input.phone.replace(/\D/g, "");

  const existing = await adminDb
    .select({ id: users.id, email: users.email, phone: users.phone })
    .from(users)
    .where(or(eq(users.email, input.email), eq(users.phone, phone)))
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
        slug: `${slugify(input.clinicName)}-${tenantId.slice(0, 8)}`,
        plan: "free",
      });

      await tx.insert(users).values({
        id: userId,
        email: input.email,
        phone,
        name: input.doctorName,
        passwordHash,
      });

      await tx.insert(memberships).values({
        tenantId,
        userId,
        role: "owner",
        status: "active",
      });

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
        .values({
          tenantId,
          clinicId: clinic.id,
          name: "Main Branch",
          isPrimary: true,
        })
        .returning();

      await tx.insert(doctors).values({
        tenantId,
        userId,
        primaryBranchId: branch.id,
        qualifications: "",
        specialties: [],
        consultationFeePaise: 0,
      });

      return { tenantId, userId };
    });

    return { ok: true, ...result };
  } catch (error) {
    const violation = uniqueViolation(error);
    if (violation?.constraint?.includes("phone")) {
      return { ok: false, field: "phone", error: "This phone number is already registered." };
    }
    if (violation) {
      return { ok: false, field: "email", error: "This email is already registered." };
    }
    throw error;
  }
}
```

- [ ] **Step 5: Add the server action**

`src/server/auth/actions.ts`:

```ts
"use server";

import { signIn } from "@/auth";
import { createClinicAccount } from "@/server/auth/create-clinic";
import { onboardingSchema } from "@/server/validation/onboarding";

export type SignupState = { error?: string; field?: string };

export async function signupAction(_prev: SignupState, formData: FormData): Promise<SignupState> {
  const parsed = onboardingSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { error: issue.message, field: String(issue.path[0] ?? "form") };
  }

  const result = await createClinicAccount(parsed.data);
  if (!result.ok) return { error: result.error, field: result.field };

  await signIn("credentials", {
    email: parsed.data.email,
    password: parsed.data.password,
    redirectTo: "/dashboard",
  });

  return {};
}
```

- [ ] **Step 6: Add the sign-up page**

`src/app/(auth)/signup/page.tsx`:

```tsx
"use client";

import { useActionState } from "react";
import { signupAction, type SignupState } from "@/server/auth/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const initialState: SignupState = {};

export default function SignupPage() {
  const [state, action, pending] = useActionState(signupAction, initialState);

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Create your clinic</h1>
        <p className="text-sm text-muted-foreground">Ten minutes to your first prescription.</p>
      </div>
      <form action={action} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="clinicName">Clinic name</Label>
          <Input id="clinicName" name="clinicName" required minLength={2} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="doctorName">Your name</Label>
          <Input id="doctorName" name="doctorName" required minLength={2} placeholder="Dr. Meera Shah" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input id="email" name="email" type="email" required />
          </div>
          <div className="space-y-2">
            <Label htmlFor="phone">Phone</Label>
            <Input id="phone" name="phone" inputMode="numeric" required pattern="[0-9]{10,15}" />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-2">
            <Label htmlFor="password">Password</Label>
            <Input id="password" name="password" type="password" required minLength={8} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="city">City</Label>
            <Input id="city" name="city" />
          </div>
        </div>
        <input type="hidden" name="country" value="IN" />
        <input type="hidden" name="timezone" value="Asia/Kolkata" />
        <input type="hidden" name="currency" value="INR" />
        {state.error ? (
          <p className="text-sm text-destructive" role="alert">
            {state.error}
          </p>
        ) : null}
        <Button type="submit" className="w-full" disabled={pending}>
          {pending ? "Creating clinic…" : "Create clinic"}
        </Button>
      </form>
      <p className="text-sm text-muted-foreground">
        Already have an account? <a className="underline" href="/login">Sign in</a>
      </p>
    </main>
  );
}
```

- [ ] **Step 7: Run tests and typecheck**

```powershell
npm run test -- tests/integration/signup.test.ts
npm run typecheck
```

Expected: PASS (3 tests); typecheck exits 0.

- [ ] **Step 8: Commit**

```powershell
git add src/server/validation src/server/auth src/app/"(auth)"/signup tests/integration/signup.test.ts
git commit -m "feat: add atomic clinic sign-up flow"
```

---

## Task 10: Authenticated app shell and dashboard

**Files:**
- Create: `src/app/(app)/layout.tsx`, `src/app/(app)/dashboard/page.tsx`, `src/app/(app)/patients/page.tsx`, `src/app/(app)/settings/page.tsx`, `src/components/app-shell/sidebar.tsx`, `tests/unit/sidebar.test.tsx`
- Modify: `src/app/page.tsx`

**Interfaces:**
- Consumes: `requireSession()`, `withTenant()`, tenancy/clinical tables.
- Produces: protected routes under `(app)`, role-aware navigation, tenant-timezone formatting.

- [ ] **Step 1: Write the failing sidebar test**

Create `tests/unit/sidebar.test.tsx`:

```tsx
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Sidebar } from "@/components/app-shell/sidebar";

describe("Sidebar", () => {
  it("shows settings only to owners", () => {
    render(<Sidebar role="owner" clinicName="Sunrise" />);
    expect(screen.getByRole("link", { name: /settings/i })).toBeInTheDocument();
  });

  it("hides settings from reception", () => {
    render(<Sidebar role="reception" clinicName="Sunrise" />);
    expect(screen.queryByRole("link", { name: /settings/i })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /patients/i })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```powershell
npm run test -- tests/unit/sidebar.test.tsx
```

Expected: FAIL — component missing.

- [ ] **Step 3: Implement the sidebar**

`src/components/app-shell/sidebar.tsx`:

```tsx
import Link from "next/link";
import { CalendarDays, LayoutDashboard, Settings, Users } from "lucide-react";

const items = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard, roles: ["owner", "doctor", "reception", "nurse", "accountant"] },
  { href: "/patients", label: "Patients", icon: Users, roles: ["owner", "doctor", "reception", "nurse"] },
  { href: "/settings", label: "Settings", icon: Settings, roles: ["owner"] },
] as const;

export function Sidebar({ role, clinicName }: { role: string; clinicName: string }) {
  const visible = items.filter((item) => (item.roles as readonly string[]).includes(role));

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r bg-background">
      <div className="border-b p-4">
        <p className="truncate text-sm font-semibold">{clinicName}</p>
        <p className="text-xs text-muted-foreground">ClinicPad</p>
      </div>
      <nav className="flex flex-col gap-1 p-2" aria-label="Main navigation">
        {visible.map((item) => {
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              className="flex items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-muted"
            >
              <Icon className="h-4 w-4" aria-hidden />
              {item.label}
            </Link>
          );
        })}
      </nav>
      <div className="mt-auto border-t p-4 text-xs text-muted-foreground">
        <CalendarDays className="mb-1 h-4 w-4" aria-hidden />
        Phase 0 · Foundation
      </div>
    </aside>
  );
}
```

- [ ] **Step 4: Implement the protected layout**

`src/app/(app)/layout.tsx`:

```tsx
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { requireSession } from "@/server/auth/session";
import { withTenant } from "@/server/db/tenant";
import { clinics, memberships } from "@/server/db/schema";
import { Sidebar } from "@/components/app-shell/sidebar";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSession();

  const data = await withTenant(session.tenantId, async (tx) => {
    const [membership] = await tx
      .select()
      .from(memberships)
      .where(eq(memberships.userId, session.userId))
      .limit(1);
    const [clinic] = await tx.select().from(clinics).limit(1);
    return { membership, clinic };
  });

  if (!data.membership || data.membership.status !== "active") redirect("/login");

  return (
    <div className="flex min-h-screen">
      <Sidebar role={data.membership.role} clinicName={data.clinic?.name ?? "ClinicPad"} />
      <main className="flex-1 p-6">{children}</main>
    </div>
  );
}
```

- [ ] **Step 5: Implement the dashboard**

`src/app/(app)/dashboard/page.tsx`:

```tsx
import { count, eq } from "drizzle-orm";
import { requireSession } from "@/server/auth/session";
import { withTenant } from "@/server/db/tenant";
import { clinics, patients, prescriptions } from "@/server/db/schema";
import { formatMoney, money } from "@/lib/domain/money";
import type { Currency } from "@/lib/domain/money";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const { tenantId } = await requireSession();

  const data = await withTenant(tenantId, async (tx) => {
    const [clinic] = await tx.select().from(clinics).limit(1);
    const [patientCount] = await tx.select({ value: count() }).from(patients);
    const [rxCount] = await tx
      .select({ value: count() })
      .from(prescriptions)
      .where(eq(prescriptions.status, "finalized"));
    return { clinic, patientCount: patientCount.value, rxCount: rxCount.value };
  });

  const now = new Intl.DateTimeFormat("en-IN", {
    dateStyle: "full",
    timeStyle: "short",
    timeZone: data.clinic?.timezone ?? "Asia/Kolkata",
  }).format(new Date());

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">{data.clinic?.name ?? "Your clinic"}</h1>
        <p className="text-sm text-muted-foreground">{now}</p>
      </header>

      <section className="grid gap-4 sm:grid-cols-3">
        <Stat label="Patients" value={String(data.patientCount)} />
        <Stat label="Finalized prescriptions" value={String(data.rxCount)} />
        <Stat
          label="Consultation fee"
          value={formatMoney(money(0, (data.clinic?.currency ?? "INR") as Currency))}
        />
      </section>

      <section className="rounded-lg border p-6">
        <h2 className="font-medium">Phase 0 is working</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Your clinic, timezone ({data.clinic?.timezone ?? "Asia/Kolkata"}), and currency are loaded
          from the database with row-level security.
        </p>
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border p-4">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold">{value}</p>
    </div>
  );
}
```

- [ ] **Step 6: Add Patients and Settings placeholders**

`src/app/(app)/patients/page.tsx`:

```tsx
export default function PatientsPage() {
  return (
    <div className="space-y-2">
      <h1 className="text-2xl font-semibold">Patients</h1>
      <p className="text-sm text-muted-foreground">Patient management arrives in Phase 1.</p>
    </div>
  );
}
```

`src/app/(app)/settings/page.tsx`:

```tsx
import { redirect } from "next/navigation";
import { requireSession } from "@/server/auth/session";
import { withTenant } from "@/server/db/tenant";
import { clinics, tenants } from "@/server/db/schema";

export default async function SettingsPage() {
  const { tenantId, role } = await requireSession();
  if (role !== "owner") redirect("/dashboard");

  const data = await withTenant(tenantId, async (tx) => {
    const [tenant] = await tx.select().from(tenants).limit(1);
    const [clinic] = await tx.select().from(clinics).limit(1);
    return { tenant, clinic };
  });

  return (
    <div className="max-w-2xl space-y-6">
      <h1 className="text-2xl font-semibold">Clinic settings</h1>
      <dl className="divide-y rounded-lg border">
        {[
          ["Tenant", data.tenant?.name],
          ["Plan", data.tenant?.plan],
          ["Region", data.tenant?.region],
          ["Timezone", data.clinic?.timezone],
          ["Currency", data.clinic?.currency],
        ].map(([label, value]) => (
          <div key={label} className="flex justify-between gap-4 p-4 text-sm">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="font-medium">{value ?? "—"}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
```

- [ ] **Step 7: Redirect the root page**

Replace `src/app/page.tsx` with:

```tsx
import { redirect } from "next/navigation";

export default function HomePage() {
  redirect("/dashboard");
}
```

- [ ] **Step 8: Run tests, typecheck, and lint**

```powershell
npm run test -- tests/unit/sidebar.test.tsx
npm run typecheck
npm run lint
```

Expected: PASS; typecheck and lint exit 0.

- [ ] **Step 9: Commit**

```powershell
git add "src/app/(app)" src/components/app-shell src/app/page.tsx tests/unit/sidebar.test.tsx
git commit -m "feat: add authenticated app shell and tenant-aware dashboard"
```

---

## Task 11: Idempotent demo seed

**Files:**
- Create: `src/server/db/seed.ts`, `tests/integration/seed.test.ts`
- Modify: `package.json` (already has `db:seed`)

**Interfaces:**
- Consumes: `adminDb`, password hashing, all tables.
- Produces: `seedDemo()` and `npm run db:seed`; demo login `owner@demo.clinicpad.app` / `ClinicPad!2026`.

- [ ] **Step 1: Write the failing idempotency test**

Create `tests/integration/seed.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { adminDb } from "@/server/db/admin";
import { patients, tenants, users } from "@/server/db/schema";
import { seedDemo } from "@/server/db/seed";

describe("seedDemo", () => {
  it("is idempotent and creates 50 patients", async () => {
    await seedDemo();
    await seedDemo();

    const [tenant] = await adminDb.select().from(tenants).where(eq(tenants.slug, "demo-clinic"));
    expect(tenant).toBeTruthy();

    const rows = await adminDb.select().from(patients).where(eq(patients.tenantId, tenant.id));
    expect(rows).toHaveLength(50);

    const [owner] = await adminDb
      .select()
      .from(users)
      .where(eq(users.email, "owner@demo.clinicpad.app"));
    expect(owner).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```powershell
npm run test -- tests/integration/seed.test.ts
```

Expected: FAIL — module missing.

- [ ] **Step 3: Implement the seed**

`src/server/db/seed.ts`:

```ts
import { eq, inArray } from "drizzle-orm";
import { adminDb } from "@/server/db/admin";
import {
  branches,
  clinics,
  doctors,
  memberships,
  patients,
  prescriptionItems,
  prescriptions,
  tenants,
  users,
  visits,
} from "@/server/db/schema";
import { hashPassword } from "@/server/auth/password";
import { newId } from "@/lib/domain/ids";

const DEMO_SLUG = "demo-clinic";
const DEMO_PASSWORD = "ClinicPad!2026";

const firstNames = ["Asha", "Ravi", "Meera", "Arjun", "Kavya", "Vikram", "Priya", "Rahul", "Sneha", "Imran"];
const lastNames = ["Rao", "Sharma", "Iyer", "Patel", "Nair", "Singh", "Das", "Khan", "Joshi", "Reddy"];

export async function seedDemo(): Promise<void> {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Refusing to seed a production database");
  }

  const passwordHash = await hashPassword(DEMO_PASSWORD);

  const existing = await adminDb.select().from(tenants).where(eq(tenants.slug, DEMO_SLUG)).limit(1);
  if (existing[0]) {
    await adminDb.delete(tenants).where(eq(tenants.id, existing[0].id));
  }

  await adminDb
    .delete(users)
    .where(
      inArray(users.email, [
        "owner@demo.clinicpad.app",
        "doctor@demo.clinicpad.app",
        "reception@demo.clinicpad.app",
      ]),
    );

  await adminDb.transaction(async (tx) => {
    const tenantId = newId();

    await tx.insert(tenants).values({
      id: tenantId,
      name: "Demo Clinic",
      slug: DEMO_SLUG,
      plan: "clinic",
    });

    const [clinic] = await tx
      .insert(clinics)
      .values({
        tenantId,
        name: "Sunrise Family Clinic",
        addressLine1: "12 MG Road",
        city: "Pune",
        state: "Maharashtra",
        pincode: "411001",
        country: "IN",
        timezone: "Asia/Kolkata",
        currency: "INR",
      })
      .returning();

    const [mainBranch] = await tx
      .insert(branches)
      .values({ tenantId, clinicId: clinic.id, name: "Main Branch", isPrimary: true })
      .returning();

    const staff = [
      { email: "owner@demo.clinicpad.app", name: "Dr. Meera Shah", role: "owner" as const },
      { email: "doctor@demo.clinicpad.app", name: "Dr. Arjun Rao", role: "doctor" as const },
      { email: "reception@demo.clinicpad.app", name: "Kavya Nair", role: "reception" as const },
    ];

    for (const person of staff) {
      const userId = newId();
      await tx.insert(users).values({
        id: userId,
        email: person.email,
        name: person.name,
        passwordHash,
      });
      await tx.insert(memberships).values({
        tenantId,
        userId,
        role: person.role,
        status: "active",
      });
      await tx.insert(doctors).values({
        tenantId,
        userId,
        primaryBranchId: mainBranch.id,
        qualifications: "MBBS, MD",
        specialties: ["General Medicine"],
      });
    }

    const patientIds: string[] = [];
    for (let i = 0; i < 50; i++) {
      const [patient] = await tx
        .insert(patients)
        .values({
          tenantId,
          name: `${firstNames[i % firstNames.length]} ${lastNames[i % lastNames.length]}`,
          phone: `90000000${String(i).padStart(2, "0")}`,
          phoneNormalized: `90000000${String(i).padStart(2, "0")}`,
          gender: i % 2 === 0 ? "female" : "male",
          allergies: i % 7 === 0 ? ["Penicillin"] : [],
        })
        .returning();
      patientIds.push(patient.id);
    }

    for (let i = 0; i < 20; i++) {
      const [visit] = await tx
        .insert(visits)
        .values({
          tenantId,
          patientId: patientIds[i],
          branchId: mainBranch.id,
          status: "finalized",
          visitType: i % 3 === 0 ? "follow-up" : "new",
          chiefComplaint: "Fever and body ache",
          diagnosis: ["Viral fever"],
          advice: "Rest, fluids, review if fever persists beyond 3 days.",
          finalizedAt: new Date(),
        })
        .returning();

      const [rx] = await tx
        .insert(prescriptions)
        .values({
          tenantId,
          visitId: visit.id,
          rxNo: i + 1,
          version: 1,
          status: "finalized",
          finalizedAt: new Date(),
        })
        .returning();

      await tx.insert(prescriptionItems).values([
        {
          tenantId,
          prescriptionId: rx.id,
          sortOrder: 0,
          drugName: "Paracetamol",
          strength: "500 mg",
          form: "tablet",
          dose: "1 tablet",
          timing: "TDS",
          durationDays: 3,
        },
        {
          tenantId,
          prescriptionId: rx.id,
          sortOrder: 1,
          drugName: "Cetirizine",
          strength: "10 mg",
          form: "tablet",
          dose: "1 tablet",
          timing: "HS",
          durationDays: 5,
        },
      ]);
    }
  });

  console.log("Seed complete: demo-clinic with 50 patients and 20 prescriptions");
  console.log(`Login: owner@demo.clinicpad.app / ${DEMO_PASSWORD}`);
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}`) {
  seedDemo().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
```

- [ ] **Step 4: Run the seed test twice**

```powershell
npm run test -- tests/integration/seed.test.ts
```

Expected: PASS (1 test). The test invokes the seed twice; the second run must replace, not duplicate.

- [ ] **Step 5: Run the script manually**

```powershell
npm run db:seed
```

Expected: prints the demo login. Counts remain 50/20.

- [ ] **Step 6: Commit**

```powershell
git add src/server/db/seed.ts tests/integration/seed.test.ts
git commit -m "feat: add idempotent demo clinic seed"
```

---

## Task 12: Playwright smoke test, CI, and Gate 0 verification

**Files:**
- Create: `playwright.config.ts`, `tests/e2e/smoke.spec.ts`, `.github/workflows/ci.yml`, `scripts/verify-gate-0.mjs`
- Modify: `docs/PROGRESS.md`

**Interfaces:**
- Consumes: everything above.
- Produces: an automated gate check and a green CI pipeline.

- [ ] **Step 1: Install Playwright**

```powershell
npm install -D @playwright/test
npx playwright install chromium
```

- [ ] **Step 2: Add `playwright.config.ts`**

```ts
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: "http://localhost:3000",
    trace: "on-first-retry",
  },
  webServer: {
    command: "npm run dev",
    url: "http://localhost:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
```

- [ ] **Step 3: Add the smoke test**

`tests/e2e/smoke.spec.ts`:

```ts
import { expect, test } from "@playwright/test";

test("login page renders", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: /sign in to clinicpad/i })).toBeVisible();
  await expect(page.getByLabel("Email")).toBeVisible();
  await expect(page.getByLabel("Password")).toBeVisible();
});

test("signup page renders", async ({ page }) => {
  await page.goto("/signup");
  await expect(page.getByRole("heading", { name: /create your clinic/i })).toBeVisible();
  await expect(page.getByLabel("Clinic name")).toBeVisible();
});
```

- [ ] **Step 4: Add the CI workflow**

`.github/workflows/ci.yml`:

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  verify:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16-alpine
        env:
          POSTGRES_USER: clinicpad
          POSTGRES_PASSWORD: clinicpad
          POSTGRES_DB: clinicpad
        ports:
          - 5432:5432
        options: >-
          --health-cmd "pg_isready -U clinicpad -d clinicpad"
          --health-interval 5s
          --health-timeout 5s
          --health-retries 10
    env:
      DATABASE_URL: postgresql://clinicpad_app:clinicpad_app@localhost:5432/clinicpad
      DIRECT_URL: postgresql://clinicpad:clinicpad@localhost:5432/clinicpad
      AUTH_SECRET: ci-only-secret-change-me-32-bytes-minimum
      NEXT_PUBLIC_APP_URL: http://localhost:3000
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run db:migrate
      - run: npm run lint
      - run: npm run typecheck
      - run: npm run test
      - run: npm run build:web
```

- [ ] **Step 5: Add the gate verifier**

`scripts/verify-gate-0.mjs`:

```js
import { execSync } from "node:child_process";

const commands = [
  "node scripts/verify-build-config.mjs",
  "npm run lint",
  "npm run typecheck",
  "npm run test",
  "npm run build:web",
];

let failed = false;
for (const command of commands) {
  console.log(`\n$ ${command}`);
  try {
    execSync(command, { stdio: "inherit" });
  } catch {
    failed = true;
    break;
  }
}

if (failed) {
  console.error("\nGate 0 verification FAILED");
  process.exit(1);
}
console.log("\nGate 0 verification PASSED");
```

- [ ] **Step 6: Run the full gate**

```powershell
docker compose up -d
npm run db:migrate
npm run db:seed
npm run test:e2e
node scripts/verify-gate-0.mjs
```

Expected: all pass; Playwright reports 2 passing tests; gate printed `PASSED`.

- [ ] **Step 7: Complete the manual gate checks**

- [ ] Sign up a new clinic at `/signup`; confirm redirect to `/dashboard`.
- [ ] Sign out and sign back in with the new account.
- [ ] Open `/settings` as owner; confirm timezone/currency.
- [ ] Create a reception user manually in the DB and confirm `/settings` redirects for that role.
- [ ] Confirm `GET /api/health` returns `{ "status": "ok" }`.
- [ ] Confirm `git status` has no secrets or build artefacts.
- [ ] Run `scripts/check-superpowers.ps1`; confirm 10/10.

- [ ] **Step 8: Update `docs/PROGRESS.md`**

Tick every Phase 0 checklist item with evidence, fill the Gate 0 evidence block, update the snapshot and session log. Do not tick an item without a command output or link.

- [ ] **Step 9: Commit and open the gate review**

```powershell
git add playwright.config.ts tests/e2e .github scripts/verify-gate-0.mjs docs/PROGRESS.md
git commit -m "chore: add CI, e2e smoke, and Gate 0 verification"
```

**Gate 0 decision:** proceed to Phase 1 only if every item in `docs/PROGRESS.md` §4 is checked and the evidence block is filled. If auth or RLS is flaky, fix it here — Phase 1 depends on both.
