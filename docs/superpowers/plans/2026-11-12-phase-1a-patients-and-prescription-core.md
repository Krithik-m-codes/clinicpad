# ClinicPad Phase 1A — Patients and the Prescription Core

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A signed-in clinic user can register and search patients, and a doctor can draft, finalize, amend, and repeat a prescription, with immutability enforced in the database, per-clinic Rx numbering, and an audit trail. Working end to end in the browser, but with a plain (unstyled-to-template) prescription editor.

**Architecture:** Domain rules are pure functions in `src/lib/domain/`. Business logic lives in `src/server/services/*` as functions that take a `ServiceContext` (`{ userId, tenantId, role }` from the session, never from input), enforce permissions, run inside `withTenant()` so RLS applies, and return a typed `Result`. Server actions in `src/server/actions/*` are thin wrappers that call `requireSession()` and a service. Postgres triggers make finalized prescriptions, their items, and their visits immutable even for the admin connection.

**Tech Stack:** Next.js 15.5 (App Router, server actions), React 19, TypeScript strict, Drizzle ORM 0.45 + drizzle-kit 0.31, Postgres 16 with RLS, Zod 4, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-06-clinicpad-platform-design.md` (roles §4, data model §5, exit criteria). Roadmap context: `docs/ROADMAP.md` §3 (Phase 1). Data model reference: `docs/DATA_MODEL.md` §3.3–3.4.

## Where this plan sits in Phase 1

Phase 1 (ROADMAP §3) is ~36 working days across ten workstreams. It is split into three plans so each ships working software:

| Plan | Roadmap workstreams | Ships |
|---|---|---|
| **1A (this plan)** | 1.1 (CRUD, search, duplicate warning), 1.2 (draft, finalize, versioning, numbering, repeat), 1.8 (per-patient prescription list), 1.9 (audit) | Patients + prescription lifecycle, immutable, audited |
| 1B (next) | 1.3 clinical form (vitals, tests, rich fields, `MedicalForm` migration), 1.4 medicine catalogue, 1.5 template renderer + 3 built-in templates, 1.6 server PDF + print | A prescription that looks like a real pad and prints/downloads |
| 1C (after) | 1.1 rest (CSV import, merge tool), 1.7 sharing (WhatsApp link, email), 1.8 filters, 1.10 hardening (Hindi/English, keyboard flow, empty states) | Pilot-ready for design partners |

Do not pull 1B/1C work into this plan.

## Global Constraints

- Node.js 22+; npm only (commit `package-lock.json`).
- TypeScript strict; no `any`; no `@ts-ignore`.
- Every business table has `tenant_id UUID NOT NULL`; RLS is enabled **and forced** on all of them (new tables included).
- `tenant_id`, `user_id`, and `role` come from the session (`requireSession()`), never from request input or form fields.
- Feature code reaches tenant data only through `withTenant()`. `adminDb` is for auth, sign-up, seed, and tests.
- Finalized prescriptions are never overwritten: amendments create a new version with a reason (AGENTS.md invariant 3).
- Creating, amending, finalizing, and archiving write an append-only audit event (invariant 2). Audit payloads carry ids, counts, and field **names**, not free-text patient data.
- Dates: store UTC; patient `dob` is a calendar date string `YYYY-MM-DD`.
- IDs are UUIDv7 (`newId()`); human-facing numbers (`patient_no`, `rx_no`) are per-tenant sequences.
- Every service returns `Result<T>` (`{ ok: true, value } | { ok: false, code, message, field? }`); no thrown strings.
- Use existing shadcn/ui primitives; do not add a UI kit.
- Conventional commits; one logical change per commit; end commit messages with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- **Windows:** run all vitest commands from a path with an uppercase drive letter (`E:\projects\clinicpad`). A lowercase `e:` cwd makes every test fail with `Cannot read properties of undefined (reading 'config')`.
- Before every commit run `npm run lint && npm run typecheck && npm run test` and show the output.

## Review Focus

Failure modes most likely to hurt a real clinic that no happy-path test would catch. Each is pinned to a test in the owning task.

1. **A role that should not finalize or amend calls the service anyway** (reception, nurse, accountant). Hiding buttons is not security. → Task 6 and Task 7 permission tests.
2. **Double-click / concurrent finalize.** Two requests finalizing the same draft must yield exactly one Rx number and one conflict, and must not burn a number. → Task 7.
3. **Search input that is not a name.** `%`, `_`, phone numbers in `+91 98765 43210` form, partial digits, a patient number, and Devanagari names must all behave (no match-everything wildcard, no 500). → Task 4.
4. **Cross-tenant id guessing.** A patient or prescription id from another clinic, or a malformed id, must return `not_found` and never leak or throw a 500. → Task 4, 6, 7.
5. **Mutating a finalized record by any path**, including a direct SQL update on the admin connection and cascade-deleting a tenant that owns finalized records. The first must fail, the second must still work. → Task 2.

---

## File Structure

**Create**
- `src/lib/result.ts` — `Result`, `ok`, `fail`, `invalidFrom`.
- `src/lib/domain/phone.ts` — `normalizePhone`.
- `src/lib/domain/names.ts` — `nameKey`, `sameName`.
- `src/lib/domain/age.ts` — `ageLabel`.
- `src/lib/domain/permissions.ts` — `can(role, action)`.
- `src/server/services/context.ts` — `ServiceContext`.
- `src/server/services/numbering.ts` — `allocateNumber`.
- `src/server/services/audit.ts` — `recordAudit`.
- `src/server/services/patients.ts` — patient service.
- `src/server/services/prescriptions.ts` — prescription service.
- `src/server/validation/patient.ts`, `src/server/validation/prescription.ts` — Zod schemas.
- `src/server/actions/patients.ts`, `src/server/actions/prescriptions.ts` — server actions.
- `src/components/patients/patient-form.tsx` — shared create/edit form (client).
- `src/components/rx/draft-editor.tsx` — draft editor (client).
- `src/app/(app)/patients/new/page.tsx`, `src/app/(app)/patients/[id]/page.tsx`, `src/app/(app)/prescriptions/[id]/page.tsx`.
- `drizzle/0003_*.sql` (generated), `drizzle/0004_phase1_integrity.sql` (custom).
- `tests/helpers/tenant.ts`; unit tests `tests/unit/{phone,names,age,permissions}.test.ts`; integration tests `tests/integration/{immutability,numbering-audit,patients,prescriptions-draft,prescriptions-lifecycle}.test.ts`; e2e `tests/e2e/helpers.ts`, `tests/e2e/patients.spec.ts`, `tests/e2e/prescriptions.spec.ts`.

**Modify**
- `src/server/db/schema/clinical.ts` — `tenantCounters`, `patients.patientNo`, prescription columns.
- `src/server/db/tenant.ts` — export `TenantTx`.
- `src/lib/domain/ids.ts` — `isUuid`.
- `src/server/db/seed.ts` — patient numbers, counters, items-before-finalize.
- `src/app/(app)/patients/page.tsx` — real list + search.
- `vitest.config.mts` — longer test timeout.
- `docs/PROGRESS.md`, `AGENTS.md`.

---

## Task 1: Domain primitives (pure, TDD)

**Files:**
- Create: `src/lib/domain/phone.ts`, `src/lib/domain/names.ts`, `src/lib/domain/age.ts`, `src/lib/domain/permissions.ts`
- Test: `tests/unit/phone.test.ts`, `tests/unit/names.test.ts`, `tests/unit/age.test.ts`, `tests/unit/permissions.test.ts`

**Interfaces:**
- Produces: `normalizePhone(raw: string): string | null`; `nameKey(name: string): string`; `sameName(a: string, b: string): boolean`; `ageLabel(dob: string, now: Date): string`; `type Action`, `can(role: string | null | undefined, action: Action): boolean`.

- [ ] **Step 1: Write the failing tests**

`tests/unit/phone.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { normalizePhone } from "@/lib/domain/phone";

describe("normalizePhone", () => {
  it.each([
    ["9876543210", "9876543210"],
    ["98765 43210", "9876543210"],
    ["98765-43210", "9876543210"],
    ["+91 98765 43210", "9876543210"],
    ["919876543210", "9876543210"],
    ["09876543210", "9876543210"],
    ["(022) 2345 6789", "2223456789"],
    ["+44 7911 123456", "447911123456"],
  ])("normalizes %s", (input, expected) => {
    expect(normalizePhone(input)).toBe(expected);
  });

  it.each(["", "   ", "abc", "12345", "+91 98", "+1"])("rejects %j", (input) => {
    expect(normalizePhone(input)).toBeNull();
  });

  it("does not strip a leading 91 from a 10-digit national number", () => {
    expect(normalizePhone("9123456789")).toBe("9123456789");
  });
});
```

`tests/unit/names.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { nameKey, sameName } from "@/lib/domain/names";

describe("nameKey", () => {
  it("lowercases, collapses whitespace, and drops punctuation", () => {
    expect(nameKey("  Asha   RAO ")).toBe("asha rao");
    expect(nameKey("Asha-Rao")).toBe("asha rao");
  });

  it("drops a leading honorific", () => {
    expect(nameKey("Mrs. Asha Rao")).toBe("asha rao");
    expect(nameKey("Dr Ravi Sharma")).toBe("ravi sharma");
  });

  it("keeps Devanagari letters and combining marks intact", () => {
    expect(nameKey("आशा राव")).toBe("आशा राव");
  });

  it("does not turn a name that is only an honorific into an empty key", () => {
    expect(nameKey("Baby")).toBe("baby");
  });
});

describe("sameName", () => {
  it("matches across casing and honorifics", () => {
    expect(sameName("Mr. Ravi Sharma", "ravi sharma")).toBe(true);
  });
  it("does not match different people", () => {
    expect(sameName("Ravi Sharma", "Ravi Sharma Jr")).toBe(false);
  });
});
```

`tests/unit/age.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ageLabel } from "@/lib/domain/age";

const now = new Date("2026-11-12T10:00:00Z");

describe("ageLabel", () => {
  it.each([
    ["2020-03-15", "6 y"],
    ["2024-11-13", "23 mo"],
    ["2024-11-12", "2 y"],
    ["2025-08-01", "15 mo"],
    ["2026-10-12", "1 mo"],
    ["2026-11-01", "11 d"],
    ["2026-11-12", "0 d"],
  ])("labels %s as %s", (dob, expected) => {
    expect(ageLabel(dob, now)).toBe(expected);
  });

  it.each(["", "not-a-date", "2027-01-01", "2026-13-40"])("returns empty for %j", (dob) => {
    expect(ageLabel(dob, now)).toBe("");
  });
});
```

`tests/unit/permissions.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { can } from "@/lib/domain/permissions";

describe("can", () => {
  it("lets reception register patients but not write prescriptions", () => {
    expect(can("reception", "patient.write")).toBe(true);
    expect(can("reception", "rx.draft")).toBe(false);
    expect(can("reception", "rx.finalize")).toBe(false);
    expect(can("reception", "rx.amend")).toBe(false);
  });

  it("lets owners and doctors finalize and amend", () => {
    for (const role of ["owner", "doctor"]) {
      expect(can(role, "rx.finalize")).toBe(true);
      expect(can(role, "rx.amend")).toBe(true);
    }
  });

  it("keeps nurses read-only on prescriptions", () => {
    expect(can("nurse", "rx.read")).toBe(true);
    expect(can("nurse", "rx.draft")).toBe(false);
  });

  it("denies accountants all clinical access", () => {
    expect(can("accountant", "patient.read")).toBe(false);
    expect(can("accountant", "rx.read")).toBe(false);
  });

  it("restricts archiving to owners", () => {
    expect(can("owner", "patient.archive")).toBe(true);
    expect(can("doctor", "patient.archive")).toBe(false);
  });

  it("denies unknown, empty, and missing roles", () => {
    expect(can("mystery", "patient.read")).toBe(false);
    expect(can("", "patient.read")).toBe(false);
    expect(can(null, "patient.read")).toBe(false);
    expect(can(undefined, "patient.read")).toBe(false);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

```powershell
npm run test -- tests/unit/phone.test.ts tests/unit/names.test.ts tests/unit/age.test.ts tests/unit/permissions.test.ts
```

Expected: FAIL — modules missing.

- [ ] **Step 3: Implement**

`src/lib/domain/phone.ts`:

```ts
/**
 * Normalizes a phone number for matching. Indian numbers (default) become 10 digits:
 * "+91 98765 43210", "919876543210" and "09876543210" all map to "9876543210".
 * Other "+" country codes keep their full digits. Returns null when it is not plausible.
 */
export function normalizePhone(raw: string): string | null {
  const trimmed = raw.trim();
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 0) return null;

  if (trimmed.startsWith("+") && !digits.startsWith("91")) {
    return digits.length >= 8 && digits.length <= 15 ? digits : null;
  }

  let national = digits;
  if (national.length === 12 && national.startsWith("91")) national = national.slice(2);
  else if (national.length === 11 && national.startsWith("0")) national = national.slice(1);

  return national.length >= 7 && national.length <= 15 ? national : null;
}
```

`src/lib/domain/names.ts`:

```ts
const HONORIFICS = new Set(["mr", "mrs", "ms", "miss", "dr", "master", "baby", "shri", "smt", "sri"]);

/** Comparison key for a person's name: case, spacing, punctuation and honorifics ignored. */
export function nameKey(name: string): string {
  const cleaned = name
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const parts = cleaned.split(" ");
  // Drop one leading honorific, but never reduce a name to nothing.
  if (parts.length > 1 && HONORIFICS.has(parts[0])) parts.shift();
  return parts.join(" ");
}

export function sameName(a: string, b: string): boolean {
  return nameKey(a) === nameKey(b);
}
```

`src/lib/domain/age.ts`:

```ts
/** "6 y", "15 mo" or "11 d". Empty string for a missing, malformed, or future date of birth. */
export function ageLabel(dob: string, now: Date): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dob);
  if (!m) return "";
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const born = Date.UTC(y, mo - 1, d);
  if (Number.isNaN(born) || new Date(born).getUTCMonth() !== mo - 1) return "";

  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  if (born > today) return "";

  let months = (now.getUTCFullYear() - y) * 12 + (now.getUTCMonth() - (mo - 1));
  if (now.getUTCDate() < d) months -= 1;

  if (months >= 24) return `${Math.floor(months / 12)} y`;
  if (months >= 1) return `${months} mo`;
  return `${Math.round((today - born) / 86_400_000)} d`;
}
```

`src/lib/domain/permissions.ts`:

```ts
const MATRIX = {
  "patient.read": ["owner", "doctor", "reception", "nurse"],
  "patient.write": ["owner", "doctor", "reception", "nurse"],
  "patient.archive": ["owner"],
  "rx.read": ["owner", "doctor", "reception", "nurse", "pharmacist"],
  "rx.draft": ["owner", "doctor"],
  "rx.finalize": ["owner", "doctor"],
  "rx.amend": ["owner", "doctor"],
} as const satisfies Record<string, readonly string[]>;

export type Action = keyof typeof MATRIX;

/**
 * Server-side authorization. UI hiding is convenience only; every service and server
 * action must call this (design spec §4). Unknown roles are denied.
 */
export function can(role: string | null | undefined, action: Action): boolean {
  if (!role) return false;
  return (MATRIX[action] as readonly string[]).includes(role);
}
```

- [ ] **Step 4: Run them to verify they pass**

```powershell
npm run test -- tests/unit/phone.test.ts tests/unit/names.test.ts tests/unit/age.test.ts tests/unit/permissions.test.ts
```

Expected: all PASS. If an `ageLabel` row fails, fix the code, not the table: the table values were checked by hand (for example `2024-11-13` is 23 months because the 13th has not happened yet on 2026-11-12).

- [ ] **Step 5: Typecheck and commit**

```powershell
npm run typecheck
git add src/lib/domain tests/unit
git commit -m "feat: add phone, name, age, and permission domain primitives"
```

---

## Task 2: Schema, migrations, and database-level immutability

**Files:**
- Modify: `src/server/db/schema/clinical.ts`, `src/server/db/seed.ts`
- Create: `drizzle/0003_*.sql` (generated), `drizzle/0004_phase1_integrity.sql` (custom, via drizzle-kit)
- Test: `tests/integration/immutability.test.ts`

**Interfaces:**
- Produces (Drizzle): `tenantCounters` table (`tenantId`, `name`, `lastNo`); `patients.patientNo: number | null`; on `prescriptions`: `rxNo: number | null`, `parentPrescriptionId`, `amendmentReason`, `finalizedBy`, `updatedAt`. Database: triggers that reject changes to finalized prescriptions, their items, and their visits with SQLSTATE `23000`; partial unique index allowing one open amendment draft per prescription.
- Error contract used by later tasks: `pgErrorInfo(e).code === "23000"` means "immutable".

- [ ] **Step 1: Write the failing integration test**

`tests/integration/immutability.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { adminDb } from "@/server/db/admin";
import { withTenant } from "@/server/db/tenant";
import { pgErrorInfo } from "@/server/db/errors";
import {
  patients,
  prescriptionItems,
  prescriptions,
  tenantCounters,
  tenants,
  visits,
} from "@/server/db/schema";

let tenantId = "";
let otherTenantId = "";

async function expectCode(promise: Promise<unknown>, code: string) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error, "expected the statement to be rejected").not.toBeNull();
  expect(pgErrorInfo(error).code).toBe(code);
}

/** A visit + draft prescription with one item. */
async function draftRx(rxNo: number | null = 1) {
  const [patient] = await adminDb.insert(patients).values({ tenantId, name: "Immutable P" }).returning();
  const [visit] = await adminDb
    .insert(visits)
    .values({ tenantId, patientId: patient.id, status: "draft" })
    .returning();
  const [rx] = await adminDb
    .insert(prescriptions)
    .values({ tenantId, visitId: visit.id, rxNo, status: "draft" })
    .returning();
  const [item] = await adminDb
    .insert(prescriptionItems)
    .values({ tenantId, prescriptionId: rx.id, drugName: "Paracetamol" })
    .returning();
  return { patient, visit, rx, item };
}

async function finalize(rxId: string, visitId: string) {
  await adminDb.update(prescriptions).set({ status: "finalized", finalizedAt: new Date() }).where(eq(prescriptions.id, rxId));
  await adminDb.update(visits).set({ status: "finalized", finalizedAt: new Date() }).where(eq(visits.id, visitId));
}

beforeAll(async () => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const [t] = await adminDb.insert(tenants).values({ name: "Immut", slug: `immut-${stamp}` }).returning();
  const [o] = await adminDb.insert(tenants).values({ name: "Immut2", slug: `immut2-${stamp}` }).returning();
  tenantId = t.id;
  otherTenantId = o.id;
});

afterAll(async () => {
  // Deleting the tenant must still work while it owns finalized and amended records.
  await adminDb.delete(tenants).where(eq(tenants.id, tenantId));
  await adminDb.delete(tenants).where(eq(tenants.id, otherTenantId));
  const left = await adminDb.select().from(prescriptions).where(eq(prescriptions.tenantId, tenantId));
  expect(left).toHaveLength(0);
});

describe("draft prescriptions stay editable", () => {
  it("allows editing, deleting, and re-inserting items while draft", async () => {
    const { rx, item } = await draftRx(null);
    await adminDb.update(prescriptionItems).set({ dose: "2 tablets" }).where(eq(prescriptionItems.id, item.id));
    await adminDb.delete(prescriptionItems).where(eq(prescriptionItems.prescriptionId, rx.id));
    await adminDb.insert(prescriptionItems).values({ tenantId, prescriptionId: rx.id, drugName: "Cetirizine" });
    const rows = await adminDb.select().from(prescriptionItems).where(eq(prescriptionItems.prescriptionId, rx.id));
    expect(rows.map((r) => r.drugName)).toEqual(["Cetirizine"]);
  });

  it("allows several drafts without an Rx number", async () => {
    await draftRx(null);
    await draftRx(null);
  });
});

describe("finalized records are immutable, even on the admin connection", () => {
  it("rejects changing, deleting, or adding to a finalized prescription", async () => {
    const { rx, visit, item } = await draftRx(101);
    await finalize(rx.id, visit.id);

    await expectCode(adminDb.update(prescriptions).set({ rxNo: 999 }).where(eq(prescriptions.id, rx.id)), "23000");
    await expectCode(adminDb.delete(prescriptions).where(eq(prescriptions.id, rx.id)), "23000");
    await expectCode(
      adminDb.insert(prescriptionItems).values({ tenantId, prescriptionId: rx.id, drugName: "Sneaky" }),
      "23000",
    );
    await expectCode(adminDb.update(prescriptionItems).set({ dose: "9" }).where(eq(prescriptionItems.id, item.id)), "23000");
    await expectCode(adminDb.delete(prescriptionItems).where(eq(prescriptionItems.id, item.id)), "23000");
    await expectCode(adminDb.update(visits).set({ advice: "changed" }).where(eq(visits.id, visit.id)), "23000");
    await expectCode(adminDb.delete(visits).where(eq(visits.id, visit.id)), "23000");

    const [unchanged] = await adminDb.select().from(prescriptions).where(eq(prescriptions.id, rx.id));
    expect(unchanged.rxNo).toBe(101);
  });

  it("allows only the finalized -> amended status flip and nothing else", async () => {
    const { rx, visit } = await draftRx(102);
    await finalize(rx.id, visit.id);

    await expectCode(
      adminDb.update(prescriptions).set({ status: "amended", rxNo: 555 }).where(eq(prescriptions.id, rx.id)),
      "23000",
    );
    await adminDb.update(prescriptions).set({ status: "amended" }).where(eq(prescriptions.id, rx.id));
    const [flipped] = await adminDb.select().from(prescriptions).where(eq(prescriptions.id, rx.id));
    expect(flipped.status).toBe("amended");

    // Once amended it is still frozen.
    await expectCode(adminDb.update(prescriptions).set({ status: "draft" }).where(eq(prescriptions.id, rx.id)), "23000");
  });
});

describe("one open amendment per prescription", () => {
  it("rejects a second draft amendment of the same parent", async () => {
    const { rx, visit, patient } = await draftRx(103);
    await finalize(rx.id, visit.id);

    const makeChild = async (version: number) => {
      const [v] = await adminDb.insert(visits).values({ tenantId, patientId: patient.id, status: "draft" }).returning();
      return adminDb.insert(prescriptions).values({
        tenantId,
        visitId: v.id,
        rxNo: 103,
        version,
        status: "draft",
        parentPrescriptionId: rx.id,
        amendmentReason: "Dose correction",
      });
    };
    await makeChild(2);
    await expectCode(makeChild(3), "23505");
  });
});

describe("tenant counters", () => {
  it("is invisible to other tenants (RLS)", async () => {
    await adminDb.insert(tenantCounters).values({ tenantId, name: "rx", lastNo: 7 }).onConflictDoNothing();
    const mine = await withTenant(tenantId, (tx) => tx.select().from(tenantCounters));
    expect(mine.some((r) => r.name === "rx")).toBe(true);
    const theirs = await withTenant(otherTenantId, (tx) => tx.select().from(tenantCounters));
    expect(theirs).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```powershell
npm run test -- tests/integration/immutability.test.ts
```

Expected: FAIL — `tenantCounters` is not exported / columns missing (TypeScript import error or SQL error).

- [ ] **Step 3: Update the Drizzle schema**

In `src/server/db/schema/clinical.ts`:

1. Extend the imports:

```ts
import {
  type AnyPgColumn,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
```

2. In `patients`, add the column after `tenantId` and the unique constraint to the table's index list:

```ts
    patientNo: integer("patient_no"),
```

```ts
    unique("patients_tenant_no_unique").on(t.tenantId, t.patientNo),
```

3. In `prescriptions`: make `rxNo` nullable (remove `.notNull()` so it reads `rxNo: integer("rx_no"),`), add these columns after `pdfUrl`:

```ts
    parentPrescriptionId: uuid("parent_prescription_id").references(
      (): AnyPgColumn => prescriptions.id,
    ),
    amendmentReason: text("amendment_reason"),
    finalizedBy: uuid("finalized_by"),
    updatedAt: updatedAt(),
```

and add this to the table's index list:

```ts
    uniqueIndex("prescriptions_one_open_amendment")
      .on(t.parentPrescriptionId)
      .where(sql`${t.status} = 'draft' and ${t.parentPrescriptionId} is not null`),
```

4. Add the counters table at the end of the file:

```ts
/** Per-tenant gap-free-on-commit sequences: name is "patient" or "rx". */
export const tenantCounters = pgTable(
  "tenant_counters",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    lastNo: integer("last_no").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.name] })],
);
```

Confirm `src/server/db/schema/index.ts` re-exports `./clinical` (it already does for the other clinical tables).

- [ ] **Step 4: Generate the structural migration and inspect it**

```powershell
npm run db:generate -- --name=phase1_core
```

Open the new `drizzle/0003_phase1_core.sql`. It must contain, and only contain: `CREATE TABLE "tenant_counters"`, `ALTER TABLE "patients" ADD COLUMN "patient_no"`, `ALTER TABLE "prescriptions" ALTER COLUMN "rx_no" DROP NOT NULL`, `ADD COLUMN` for `parent_prescription_id`, `amendment_reason`, `finalized_by`, `updated_at`, the foreign keys, the `patients_tenant_no_unique` constraint, and the partial `CREATE UNIQUE INDEX "prescriptions_one_open_amendment" ... WHERE ...`. If drizzle-kit asks whether a column was renamed, answer **no** (create). If the file drops or recreates any existing table or column, stop and fix the schema edit.

- [ ] **Step 5: Create the custom integrity migration**

```powershell
npx drizzle-kit generate --custom --name=phase1_integrity
```

Replace the contents of the new `drizzle/0004_phase1_integrity.sql` with exactly this (it was run against a scratch database before this plan was written; the draft/finalized/amended/cascade behaviours all held):

```sql
-- 1. RLS for the new counters table (same policy shape as every other tenant table).
alter table tenant_counters enable row level security;
alter table tenant_counters force row level security;
create policy tenant_isolation on tenant_counters
  for all
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
grant select, insert, update, delete on tenant_counters to clinicpad_app;

-- 2. Backfill numbers for rows created before this migration.
update patients p
set patient_no = s.n
from (
  select id, row_number() over (partition by tenant_id order by created_at, id) as n
  from patients
  where patient_no is null
) s
where p.id = s.id;

insert into tenant_counters (tenant_id, name, last_no)
select tenant_id, 'patient', max(patient_no) from patients
where patient_no is not null group by tenant_id
on conflict (tenant_id, name) do update set last_no = greatest(tenant_counters.last_no, excluded.last_no);

insert into tenant_counters (tenant_id, name, last_no)
select tenant_id, 'rx', max(rx_no) from prescriptions
where rx_no is not null group by tenant_id
on conflict (tenant_id, name) do update set last_no = greatest(tenant_counters.last_no, excluded.last_no);

-- 3. Finalized prescriptions are immutable (AGENTS.md invariant 3).
--    Direct deletes are blocked (trigger depth 1). Cascades from deleting a whole tenant
--    run at depth > 1 and are allowed, so offboarding still works.
create or replace function enforce_rx_immutability() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if old.status <> 'draft' and pg_trigger_depth() = 1 then
      raise exception 'IMMUTABLE: finalized prescriptions cannot be deleted' using errcode = '23000';
    end if;
    return old;
  end if;
  if old.status = 'draft' then return new; end if;
  if old.status = 'finalized' and new.status = 'amended'
     and (to_jsonb(new) - 'status' - 'updated_at') = (to_jsonb(old) - 'status' - 'updated_at') then
    return new;
  end if;
  raise exception 'IMMUTABLE: finalized prescriptions cannot be changed' using errcode = '23000';
end $$;

create trigger prescriptions_immutable before update or delete on prescriptions
  for each row execute function enforce_rx_immutability();

create or replace function enforce_rx_item_immutability() returns trigger language plpgsql as $$
declare rx_status text;
begin
  select status into rx_status from prescriptions
    where id = (case when tg_op = 'INSERT' then new.prescription_id else old.prescription_id end);
  if rx_status is null or rx_status = 'draft' then return coalesce(new, old); end if;
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 then return old; end if;
  raise exception 'IMMUTABLE: items of a finalized prescription cannot be changed' using errcode = '23000';
end $$;

create trigger prescription_items_immutable before insert or update or delete on prescription_items
  for each row execute function enforce_rx_item_immutability();

create or replace function enforce_visit_immutability() returns trigger language plpgsql as $$
begin
  if old.status = 'draft' then return coalesce(new, old); end if;
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 then return old; end if;
  raise exception 'IMMUTABLE: finalized visits cannot be changed' using errcode = '23000';
end $$;

create trigger visits_immutable before update or delete on visits
  for each row execute function enforce_visit_immutability();
```

- [ ] **Step 6: Apply the migrations and run the test**

```powershell
npm run db:migrate
npm run test -- tests/integration/immutability.test.ts
```

Expected: migrations apply; all tests PASS.

- [ ] **Step 7: Fix the seed so it respects the new rules**

The seed inserts items under prescriptions that are already `finalized`, which the trigger now rejects, and it does not set patient numbers or counters. In `src/server/db/seed.ts`:

1. Import `tenantCounters` from `@/server/db/schema`.
2. In the patients insert, add `patientNo: i + 1,` to each value object.
3. Directly after the patients insert, add:

```ts
    await tx.insert(tenantCounters).values([
      { tenantId, name: "patient", lastNo: PATIENT_COUNT },
      { tenantId, name: "rx", lastNo: PRESCRIPTION_COUNT },
    ]);
```

4. In the prescriptions insert, change `status: "finalized", finalizedAt: now,` to `status: "draft",`. After the `prescriptionItems` insert, add:

```ts
    // Items go in while draft; the immutability trigger forbids adding them afterwards.
    await tx
      .update(prescriptions)
      .set({ status: "finalized", finalizedAt: now, finalizedBy: ownerId })
      .where(eq(prescriptions.tenantId, tenantId));
```

- [ ] **Step 8: Re-run the seed test, the whole suite, and typecheck**

```powershell
npm run test
npm run typecheck
npm run db:seed
```

Expected: all PASS (the seed test still shows 50 patients / 20 prescriptions); seed prints the demo login.

- [ ] **Step 9: Commit**

```powershell
git add src/server/db drizzle tests/integration/immutability.test.ts
git commit -m "feat: add counters, amendment columns, and DB-level immutability"
```

---

## Task 3: Service plumbing — results, numbering, audit, test helper

**Files:**
- Create: `src/lib/result.ts`, `src/server/services/context.ts`, `src/server/services/numbering.ts`, `src/server/services/audit.ts`, `tests/helpers/tenant.ts`
- Modify: `src/server/db/tenant.ts`, `src/lib/domain/ids.ts`, `vitest.config.mts`
- Test: `tests/integration/numbering-audit.test.ts`

**Interfaces:**
- Produces:
  - `type Result<T> = Ok<T> | ServiceError`; `ok(value)`, `fail(code, message, field?)`, `invalidFrom(zodError)`; `ErrorCode = "forbidden" | "not_found" | "invalid" | "conflict" | "immutable"`.
  - `type ServiceContext = { userId: string; tenantId: string; role: string }`.
  - `type TenantTx` (exported from `src/server/db/tenant.ts`).
  - `allocateNumber(tx: TenantTx, tenantId: string, name: "patient" | "rx"): Promise<number>`.
  - `recordAudit(tx: TenantTx, ctx: ServiceContext, event: AuditInput): Promise<void>`.
  - `isUuid(value: string): boolean`.
  - Test helper `createTestTenant(label): Promise<TestTenant>` with `.tenantId`, `.as(role): ServiceContext`, `.cleanup()`.

- [ ] **Step 1: Write the failing test**

`tests/integration/numbering-audit.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { withTenant } from "@/server/db/tenant";
import { pgErrorInfo } from "@/server/db/errors";
import { auditEvents } from "@/server/db/schema";
import { allocateNumber } from "@/server/services/numbering";
import { recordAudit } from "@/server/services/audit";
import { isUuid, newId } from "@/lib/domain/ids";
import { createTestTenant, type TestTenant } from "../helpers/tenant";

let A: TestTenant;
let B: TestTenant;

beforeAll(async () => {
  A = await createTestTenant("numa");
  B = await createTestTenant("numb");
});
afterAll(async () => {
  await A.cleanup();
  await B.cleanup();
});

describe("allocateNumber", () => {
  it("counts per tenant and per sequence name", async () => {
    const a1 = await withTenant(A.tenantId, (tx) => allocateNumber(tx, A.tenantId, "patient"));
    const a2 = await withTenant(A.tenantId, (tx) => allocateNumber(tx, A.tenantId, "patient"));
    const aRx = await withTenant(A.tenantId, (tx) => allocateNumber(tx, A.tenantId, "rx"));
    const b1 = await withTenant(B.tenantId, (tx) => allocateNumber(tx, B.tenantId, "patient"));
    expect([a1, a2, aRx, b1]).toEqual([1, 2, 1, 1]);
  });

  it("hands out unique consecutive numbers under concurrency", async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, () => withTenant(A.tenantId, (tx) => allocateNumber(tx, A.tenantId, "rx"))),
    );
    const sorted = [...results].sort((x, y) => x - y);
    // "rx" was already at 1 from the previous test.
    expect(sorted).toEqual(Array.from({ length: 10 }, (_, i) => i + 2));
  });

  it("does not burn a number when the transaction rolls back", async () => {
    const before = await withTenant(B.tenantId, (tx) => allocateNumber(tx, B.tenantId, "rx"));
    await expect(
      withTenant(B.tenantId, async (tx) => {
        await allocateNumber(tx, B.tenantId, "rx");
        throw new Error("abort");
      }),
    ).rejects.toThrow("abort");
    const after = await withTenant(B.tenantId, (tx) => allocateNumber(tx, B.tenantId, "rx"));
    expect(after).toBe(before + 1);
  });
});

describe("recordAudit", () => {
  it("writes an event attributed to the actor and tenant", async () => {
    const ctx = A.as("owner");
    const entityId = newId();
    await withTenant(A.tenantId, (tx) =>
      recordAudit(tx, ctx, {
        action: "test.happened",
        entityType: "test",
        entityId,
        after: { n: 1 },
      }),
    );
    const rows = await withTenant(A.tenantId, (tx) =>
      tx.select().from(auditEvents).where(eq(auditEvents.entityId, entityId)),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tenantId: A.tenantId, actorUserId: ctx.userId, action: "test.happened" });
  });

  it("is append-only for the application role", async () => {
    const update = withTenant(A.tenantId, (tx) => tx.update(auditEvents).set({ action: "tampered" }));
    await expect(update).rejects.toSatisfy((e: unknown) => pgErrorInfo(e).code === "42501");
    const del = withTenant(A.tenantId, (tx) => tx.delete(auditEvents));
    await expect(del).rejects.toSatisfy((e: unknown) => pgErrorInfo(e).code === "42501");
  });
});

describe("isUuid", () => {
  it("accepts UUIDv7 and rejects junk", () => {
    expect(isUuid(newId())).toBe(true);
    expect(isUuid("abc")).toBe(false);
    expect(isUuid("")).toBe(false);
    expect(isUuid("1; drop table patients")).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```powershell
npm run test -- tests/integration/numbering-audit.test.ts
```

Expected: FAIL — modules missing.

- [ ] **Step 3: Implement**

`src/lib/result.ts`:

```ts
import type { ZodError } from "zod";

export type ErrorCode = "forbidden" | "not_found" | "invalid" | "conflict" | "immutable";

export type Ok<T> = { ok: true; value: T };
export type ServiceError = { ok: false; code: ErrorCode; message: string; field?: string };
export type Result<T> = Ok<T> | ServiceError;

export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

export function fail(code: ErrorCode, message: string, field?: string): ServiceError {
  return field ? { ok: false, code, message, field } : { ok: false, code, message };
}

/** First Zod issue as a field-level error. */
export function invalidFrom(error: ZodError): ServiceError {
  const issue = error.issues[0];
  const field = issue.path.length > 0 ? String(issue.path[0]) : undefined;
  return fail("invalid", issue.message, field);
}
```

`src/server/services/context.ts`:

```ts
/** Identity of the caller. Always built from the server session, never from request input. */
export type ServiceContext = {
  userId: string;
  tenantId: string;
  role: string;
};
```

In `src/server/db/tenant.ts`, export the transaction type (replace the local `type Transaction` line and its usage):

```ts
export type TenantTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function withTenant<T>(
  tenantId: string,
  fn: (tx: TenantTx) => Promise<T>,
): Promise<T> {
```

`src/lib/domain/ids.ts` (append):

```ts
import { z } from "zod";

const uuidSchema = z.uuid();

/** Guard before passing a client-supplied id to a uuid column (a bad string is a 500 otherwise). */
export function isUuid(value: string): boolean {
  return uuidSchema.safeParse(value).success;
}
```

`src/server/services/numbering.ts`:

```ts
import { sql } from "drizzle-orm";
import { tenantCounters } from "@/server/db/schema";
import type { TenantTx } from "@/server/db/tenant";

export type SequenceName = "patient" | "rx";

/**
 * Next per-tenant number. The upsert takes a row lock, so concurrent callers queue and
 * each gets a distinct number; a rolled-back transaction releases its number.
 */
export async function allocateNumber(
  tx: TenantTx,
  tenantId: string,
  name: SequenceName,
): Promise<number> {
  const [row] = await tx
    .insert(tenantCounters)
    .values({ tenantId, name, lastNo: 1 })
    .onConflictDoUpdate({
      target: [tenantCounters.tenantId, tenantCounters.name],
      set: { lastNo: sql`${tenantCounters.lastNo} + 1` },
    })
    .returning({ value: tenantCounters.lastNo });
  return row.value;
}
```

`src/server/services/audit.ts`:

```ts
import { auditEvents } from "@/server/db/schema";
import type { TenantTx } from "@/server/db/tenant";
import type { ServiceContext } from "./context";

export type AuditInput = {
  action: string;
  entityType: string;
  entityId?: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
};

/**
 * Appends an audit event inside the caller's transaction, so the event commits or rolls
 * back with the change it describes. Keep payloads to ids, counts and field names:
 * do not copy free-text patient data into the audit log.
 */
export async function recordAudit(
  tx: TenantTx,
  ctx: ServiceContext,
  event: AuditInput,
): Promise<void> {
  await tx.insert(auditEvents).values({
    tenantId: ctx.tenantId,
    actorUserId: ctx.userId,
    action: event.action,
    entityType: event.entityType,
    entityId: event.entityId,
    before: event.before,
    after: event.after,
  });
}
```

`tests/helpers/tenant.ts`:

```ts
import { eq } from "drizzle-orm";
import { adminDb } from "@/server/db/admin";
import { doctors, tenants, users } from "@/server/db/schema";
import { newId } from "@/lib/domain/ids";
import type { ServiceContext } from "@/server/services/context";

export type TestTenant = {
  tenantId: string;
  /** A context for `role`. owner and doctor share one real user that has a doctor profile. */
  as: (role: string) => ServiceContext;
  cleanup: () => Promise<void>;
};

export async function createTestTenant(label: string): Promise<TestTenant> {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const [tenant] = await adminDb
    .insert(tenants)
    .values({ name: `Test ${label}`, slug: `t-${label}-${stamp}` })
    .returning();
  const [user] = await adminDb
    .insert(users)
    .values({ email: `${label}-${stamp}@example.com`, name: "Dr Test", passwordHash: "not-a-real-hash" })
    .returning();
  await adminDb.insert(doctors).values({ tenantId: tenant.id, userId: user.id });

  return {
    tenantId: tenant.id,
    as: (role) => ({
      tenantId: tenant.id,
      userId: role === "owner" || role === "doctor" ? user.id : newId(),
      role,
    }),
    cleanup: async () => {
      await adminDb.delete(tenants).where(eq(tenants.id, tenant.id));
      await adminDb.delete(users).where(eq(users.id, user.id));
    },
  };
}
```

In `vitest.config.mts`, add `testTimeout: 30_000,` inside `test: { ... }` (cold jsdom/DB starts exceed the 5 s default on this machine).

- [ ] **Step 4: Run tests and typecheck**

```powershell
npm run test -- tests/integration/numbering-audit.test.ts
npm run typecheck
```

Expected: PASS; typecheck exits 0.

- [ ] **Step 5: Commit**

```powershell
git add src tests vitest.config.mts
git commit -m "feat: add service result type, numbering, audit helper, and test tenant helper"
```

---

## Task 4: Patient service

**Files:**
- Create: `src/server/validation/patient.ts`, `src/server/services/patients.ts`
- Test: `tests/integration/patients.test.ts`

**Interfaces:**
- Consumes: Task 1 (`can`, `normalizePhone`, `sameName`), Task 3 (`Result`, `fail`, `ok`, `invalidFrom`, `allocateNumber`, `recordAudit`, `isUuid`, `withTenant`, `ServiceContext`).
- Produces:
  - `patientInputSchema`; `type PatientInput = z.output<typeof patientInputSchema>`.
  - `createPatient(ctx, raw: unknown, opts?: { allowDuplicate?: boolean }): Promise<CreatePatientResult>` where `CreatePatientResult = Ok<{ id: string; patientNo: number }> | ServiceError | { ok: false; code: "duplicate_candidates"; message: string; candidates: DuplicateCandidate[] }`.
  - `type DuplicateCandidate = { id: string; patientNo: number | null; name: string; phone: string | null; sameName: boolean }`.
  - `searchPatients(ctx, opts?: { q?: string; limit?: number; offset?: number }): Promise<Result<PatientListItem[]>>`.
  - `getPatient(ctx, id: string): Promise<Result<PatientRecord>>`.
  - `updatePatient(ctx, id: string, raw: unknown): Promise<Result<{ changedFields: string[] }>>`.
  - `archivePatient(ctx, id: string): Promise<Result<null>>`.
  - `type PatientListItem = { id; patientNo: number | null; name; phone: string | null; gender: string | null; dob: string | null; createdAt: Date }`; `type PatientRecord` = full patient row.

- [ ] **Step 1: Write the failing tests**

`tests/integration/patients.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { withTenant } from "@/server/db/tenant";
import { auditEvents } from "@/server/db/schema";
import {
  archivePatient,
  createPatient,
  getPatient,
  searchPatients,
  updatePatient,
} from "@/server/services/patients";
import { newId } from "@/lib/domain/ids";
import { createTestTenant, type TestTenant } from "../helpers/tenant";

let A: TestTenant;
let B: TestTenant;

beforeAll(async () => {
  A = await createTestTenant("pta");
  B = await createTestTenant("ptb");
});
afterAll(async () => {
  await A.cleanup();
  await B.cleanup();
});

async function create(t: TestTenant, name: string, phone?: string, extra: Record<string, unknown> = {}) {
  const result = await createPatient(t.as("reception"), { name, phone, ...extra }, { allowDuplicate: true });
  if (!result.ok) throw new Error(`setup failed: ${result.message}`);
  return result.value;
}

describe("createPatient", () => {
  it("numbers patients sequentially per tenant", async () => {
    const a1 = await create(A, "Numbering One");
    const a2 = await create(A, "Numbering Two");
    const b1 = await create(B, "Numbering Other Clinic");
    expect(a2.patientNo).toBe(a1.patientNo + 1);
    expect(b1.patientNo).toBe(1);
  });

  it("lets reception register patients but not accountants", async () => {
    expect((await createPatient(A.as("reception"), { name: "Allowed Person" })).ok).toBe(true);
    const denied = await createPatient(A.as("accountant"), { name: "Denied Person" });
    expect(denied).toMatchObject({ ok: false, code: "forbidden" });
  });

  it.each([
    [{ name: "A" }, "name"],
    [{ name: "Valid Name", phone: "12" }, "phone"],
    [{ name: "Valid Name", dob: "2999-01-01" }, "dob"],
    [{ name: "Valid Name", dob: "2026-02-31" }, "dob"],
    [{ name: "Valid Name", gender: "robot" }, "gender"],
  ])("rejects invalid input %j", async (input, field) => {
    const result = await createPatient(A.as("owner"), input);
    expect(result).toMatchObject({ ok: false, code: "invalid", field });
  });

  it("treats blank optional form fields as absent", async () => {
    const result = await createPatient(A.as("owner"), {
      name: "Blank Fields",
      phone: "",
      dob: "",
      address: "",
      notes: "",
      allergies: "",
    });
    expect(result.ok).toBe(true);
  });

  it("parses comma-separated allergies", async () => {
    const created = await create(A, "Allergic Person", undefined, { allergies: "Penicillin, Sulfa ,," });
    const got = await getPatient(A.as("owner"), created.id);
    expect(got.ok && got.value.allergies).toEqual(["Penicillin", "Sulfa"]);
  });

  it("warns about duplicates by phone across number formats, then allows confirming", async () => {
    await create(A, "Original Dup", "+91 98765 43210");

    const warned = await createPatient(A.as("reception"), { name: "Other Name", phone: "9876543210" });
    expect(warned).toMatchObject({ ok: false, code: "duplicate_candidates" });
    if (warned.ok || warned.code !== "duplicate_candidates") throw new Error("expected candidates");
    expect(warned.candidates[0]).toMatchObject({ name: "Original Dup", sameName: false });

    const sameNameWarned = await createPatient(A.as("reception"), { name: "original dup", phone: "09876543210" });
    if (sameNameWarned.ok || sameNameWarned.code !== "duplicate_candidates") throw new Error("expected candidates");
    expect(sameNameWarned.candidates[0].sameName).toBe(true);

    const confirmed = await createPatient(
      A.as("reception"),
      { name: "Family Member", phone: "9876543210" },
      { allowDuplicate: true },
    );
    expect(confirmed.ok).toBe(true);
  });

  it("does not report another clinic's patients as duplicates", async () => {
    await create(A, "Cross Clinic", "9000000001");
    const result = await createPatient(B.as("reception"), { name: "Cross Clinic", phone: "9000000001" });
    expect(result.ok).toBe(true);
  });

  it("audits creation with ids only, not the patient's name or phone", async () => {
    const created = await create(A, "Private Name Person", "9111111111");
    const rows = await withTenant(A.tenantId, (tx) =>
      tx.select().from(auditEvents).where(eq(auditEvents.entityId, created.id)),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe("patient.created");
    expect(JSON.stringify(rows[0])).not.toContain("Private Name Person");
    expect(JSON.stringify(rows[0])).not.toContain("9111111111");
  });
});

describe("searchPatients", () => {
  let tenant: TestTenant;
  let ids: Record<string, string>;

  beforeAll(async () => {
    tenant = await createTestTenant("srch");
    const seed = async (name: string, phone?: string) => (await create(tenant, name, phone)).id;
    ids = {
      asha: await seed("Asha Rao", "+91 98765 43210"),
      ravi: await seed("Ravi Sharma", "9822012345"),
      percent: await seed("100% Sure Kumar", "9000012345"),
      hindi: await seed("आशा राव", "9333312345"),
      gone: await seed("Archived Asha", "9444412345"),
    };
    await archivePatient(tenant.as("owner"), ids.gone);
  });
  afterAll(async () => tenant.cleanup());

  const names = async (q?: string, limit?: number) => {
    const result = await searchPatients(tenant.as("reception"), { q, limit });
    if (!result.ok) throw new Error(result.message);
    return result.value.map((p) => p.name);
  };

  it("matches names case-insensitively and by substring", async () => {
    expect(await names("asha")).toEqual(["Asha Rao"]);
    expect(await names("SHARMA")).toEqual(["Ravi Sharma"]);
  });

  it("matches phone numbers typed in any format, and partial digits", async () => {
    expect(await names("+91 98765 43210")).toEqual(["Asha Rao"]);
    expect(await names("98765")).toEqual(["Asha Rao"]);
    expect(await names("9822012345")).toEqual(["Ravi Sharma"]);
  });

  it("matches a patient number", async () => {
    const first = await searchPatients(tenant.as("reception"), { q: "" });
    if (!first.ok) throw new Error(first.message);
    const target = first.value.find((p) => p.name === "Ravi Sharma");
    expect(target?.patientNo).toBeTruthy();
    expect(await names(String(target?.patientNo))).toContain("Ravi Sharma");
  });

  it("treats LIKE wildcards literally", async () => {
    expect(await names("%")).toEqual(["100% Sure Kumar"]);
    expect(await names("_")).toEqual([]);
    expect(await names("\\")).toEqual([]);
  });

  it("finds Devanagari names", async () => {
    expect(await names("आशा")).toEqual(["आशा राव"]);
  });

  it("excludes archived patients", async () => {
    expect(await names("Archived")).toEqual([]);
  });

  it("returns recent patients for an empty query and respects limit", async () => {
    expect((await names("")).length).toBe(4);
    expect(await names("", 2)).toHaveLength(2);
    expect(await names("   ")).toHaveLength(4);
  });

  it("clamps absurd limits instead of failing", async () => {
    expect((await names("", 100000)).length).toBe(4);
    expect((await names("", -5)).length).toBeGreaterThan(0);
  });

  it("never returns another clinic's patients", async () => {
    const result = await searchPatients(B.as("owner"), { q: "Asha" });
    expect(result.ok && result.value.some((p) => p.name === "Asha Rao")).toBe(false);
  });

  it("denies roles without patient access", async () => {
    expect(await searchPatients(tenant.as("accountant"), { q: "" })).toMatchObject({ ok: false, code: "forbidden" });
  });
});

describe("getPatient / updatePatient / archivePatient", () => {
  it("returns not_found for another clinic's id, unknown ids, and malformed ids", async () => {
    const mine = await create(A, "Isolation Subject");
    expect(await getPatient(B.as("owner"), mine.id)).toMatchObject({ ok: false, code: "not_found" });
    expect(await getPatient(A.as("owner"), newId())).toMatchObject({ ok: false, code: "not_found" });
    expect(await getPatient(A.as("owner"), "not-a-uuid")).toMatchObject({ ok: false, code: "not_found" });
    expect(await updatePatient(B.as("owner"), mine.id, { name: "Hijacked" })).toMatchObject({
      ok: false,
      code: "not_found",
    });
    expect(await archivePatient(B.as("owner"), mine.id)).toMatchObject({ ok: false, code: "not_found" });
  });

  it("updates fields, reports which changed, and audits field names only", async () => {
    const p = await create(A, "Before Update", "9555555555");
    const result = await updatePatient(A.as("doctor"), p.id, {
      name: "After Update",
      phone: "9555555555",
      gender: "female",
    });
    expect(result).toMatchObject({ ok: true, value: { changedFields: ["name", "gender"] } });

    const got = await getPatient(A.as("doctor"), p.id);
    expect(got.ok && got.value.name).toBe("After Update");

    const audit = await withTenant(A.tenantId, (tx) =>
      tx.select().from(auditEvents).where(eq(auditEvents.entityId, p.id)),
    );
    const updated = audit.find((e) => e.action === "patient.updated");
    expect(updated?.after).toEqual({ changedFields: ["name", "gender"] });
    expect(JSON.stringify(updated)).not.toContain("After Update");
  });

  it("is a no-op, with no audit event, when nothing changed", async () => {
    const p = await create(A, "No Change", "9666666666");
    const result = await updatePatient(A.as("owner"), p.id, { name: "No Change", phone: "9666666666" });
    expect(result).toMatchObject({ ok: true, value: { changedFields: [] } });
    const audit = await withTenant(A.tenantId, (tx) =>
      tx.select().from(auditEvents).where(eq(auditEvents.entityId, p.id)),
    );
    expect(audit.filter((e) => e.action === "patient.updated")).toHaveLength(0);
  });

  it("lets only owners archive, and archived patients disappear", async () => {
    const p = await create(A, "To Archive");
    expect(await archivePatient(A.as("doctor"), p.id)).toMatchObject({ ok: false, code: "forbidden" });
    expect((await archivePatient(A.as("owner"), p.id)).ok).toBe(true);
    expect(await getPatient(A.as("owner"), p.id)).toMatchObject({ ok: false, code: "not_found" });
    expect(await archivePatient(A.as("owner"), p.id)).toMatchObject({ ok: false, code: "not_found" });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```powershell
npm run test -- tests/integration/patients.test.ts
```

Expected: FAIL — module missing.

- [ ] **Step 3: Implement the validation schema**

`src/server/validation/patient.ts`:

```ts
import { z } from "zod";
import { normalizePhone } from "@/lib/domain/phone";

const blankToUndefined = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

const optionalText = (max: number) =>
  z.preprocess(blankToUndefined, z.string().trim().max(max).optional());

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use the format YYYY-MM-DD")
  .refine((v) => {
    const d = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, "Enter a real date")
  .refine((v) => v <= new Date().toISOString().slice(0, 10), "Date of birth cannot be in the future");

/** Accepts "a, b" from a form or ["a", "b"] from code. */
const list = z.preprocess(
  (value) => {
    if (value === undefined || value === null) return [];
    if (typeof value === "string") return value.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
    return value;
  },
  z.array(z.string().trim().min(1).max(80)).max(20),
);

export const patientInputSchema = z.object({
  name: z.string().trim().min(2, "Enter the patient's name").max(120),
  phone: z.preprocess(
    blankToUndefined,
    z
      .string()
      .trim()
      .max(32)
      .refine((v) => normalizePhone(v) !== null, "Enter a valid phone number")
      .optional(),
  ),
  gender: z.enum(["female", "male", "other", "unknown"]).default("unknown"),
  dob: z.preprocess(blankToUndefined, isoDate.optional()),
  address: optionalText(300),
  allergies: list,
  notes: optionalText(2000),
});

export type PatientInput = z.output<typeof patientInputSchema>;
```

- [ ] **Step 4: Implement the service**

`src/server/services/patients.ts`:

```ts
import { and, asc, desc, eq, ilike, isNull, like, or } from "drizzle-orm";
import { fail, invalidFrom, ok, type Ok, type Result, type ServiceError } from "@/lib/result";
import { can } from "@/lib/domain/permissions";
import { normalizePhone } from "@/lib/domain/phone";
import { sameName } from "@/lib/domain/names";
import { isUuid } from "@/lib/domain/ids";
import { patients } from "@/server/db/schema";
import { withTenant } from "@/server/db/tenant";
import { patientInputSchema, type PatientInput } from "@/server/validation/patient";
import type { ServiceContext } from "./context";
import { allocateNumber } from "./numbering";
import { recordAudit } from "./audit";

export type DuplicateCandidate = {
  id: string;
  patientNo: number | null;
  name: string;
  phone: string | null;
  sameName: boolean;
};

export type CreatePatientResult =
  | Ok<{ id: string; patientNo: number }>
  | ServiceError
  | { ok: false; code: "duplicate_candidates"; message: string; candidates: DuplicateCandidate[] };

export type PatientListItem = {
  id: string;
  patientNo: number | null;
  name: string;
  phone: string | null;
  gender: string | null;
  dob: string | null;
  createdAt: Date;
};

export type PatientRecord = typeof patients.$inferSelect;

const LIST_COLUMNS = {
  id: patients.id,
  patientNo: patients.patientNo,
  name: patients.name,
  phone: patients.phone,
  gender: patients.gender,
  dob: patients.dob,
  createdAt: patients.createdAt,
};

const notFound = () => fail("not_found", "Patient not found.");

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function toColumns(input: PatientInput) {
  return {
    name: input.name,
    phone: input.phone ?? null,
    phoneNormalized: input.phone ? normalizePhone(input.phone) : null,
    gender: input.gender,
    dob: input.dob ?? null,
    address: input.address ?? null,
    allergies: input.allergies,
    notes: input.notes ?? null,
  };
}

export async function createPatient(
  ctx: ServiceContext,
  raw: unknown,
  opts: { allowDuplicate?: boolean } = {},
): Promise<CreatePatientResult> {
  if (!can(ctx.role, "patient.write")) return fail("forbidden", "You cannot register patients.");
  const parsed = patientInputSchema.safeParse(raw);
  if (!parsed.success) return invalidFrom(parsed.error);
  const input = parsed.data;
  const columns = toColumns(input);

  return withTenant(ctx.tenantId, async (tx): Promise<CreatePatientResult> => {
    if (columns.phoneNormalized && !opts.allowDuplicate) {
      const matches = await tx
        .select({ id: patients.id, patientNo: patients.patientNo, name: patients.name, phone: patients.phone })
        .from(patients)
        .where(and(eq(patients.phoneNormalized, columns.phoneNormalized), isNull(patients.deletedAt)))
        .limit(5);
      if (matches.length > 0) {
        return {
          ok: false,
          code: "duplicate_candidates",
          message: "A patient with this phone number already exists.",
          candidates: matches.map((m) => ({ ...m, sameName: sameName(m.name, input.name) })),
        };
      }
    }

    const patientNo = await allocateNumber(tx, ctx.tenantId, "patient");
    const [row] = await tx
      .insert(patients)
      .values({ ...columns, tenantId: ctx.tenantId, patientNo, createdBy: ctx.userId })
      .returning({ id: patients.id });
    await recordAudit(tx, ctx, {
      action: "patient.created",
      entityType: "patient",
      entityId: row.id,
      after: { patientNo },
    });
    return ok({ id: row.id, patientNo });
  });
}

export async function searchPatients(
  ctx: ServiceContext,
  opts: { q?: string; limit?: number; offset?: number } = {},
): Promise<Result<PatientListItem[]>> {
  if (!can(ctx.role, "patient.read")) return fail("forbidden", "You cannot view patients.");

  const term = (opts.q ?? "").trim();
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 25) || 25, 1), 100);
  const offset = Math.max(Math.trunc(opts.offset ?? 0) || 0, 0);

  const conditions = [isNull(patients.deletedAt)];
  if (term) {
    const matchers = [ilike(patients.name, `%${escapeLike(term)}%`)];
    if (/^[\d\s+()-]+$/.test(term)) {
      const digits = term.replace(/\D/g, "");
      if (digits.length >= 3) {
        matchers.push(like(patients.phoneNormalized, `%${normalizePhone(term) ?? digits}%`));
      }
      if (digits.length >= 1 && digits.length <= 7) {
        matchers.push(eq(patients.patientNo, Number(digits)));
      }
    }
    conditions.push(or(...matchers)!);
  }

  const rows = await withTenant(ctx.tenantId, (tx) =>
    tx
      .select(LIST_COLUMNS)
      .from(patients)
      .where(and(...conditions))
      .orderBy(term ? asc(patients.name) : desc(patients.createdAt))
      .limit(limit)
      .offset(offset),
  );
  return ok(rows);
}

export async function getPatient(ctx: ServiceContext, id: string): Promise<Result<PatientRecord>> {
  if (!can(ctx.role, "patient.read")) return fail("forbidden", "You cannot view patients.");
  if (!isUuid(id)) return notFound();
  const [row] = await withTenant(ctx.tenantId, (tx) =>
    tx
      .select()
      .from(patients)
      .where(and(eq(patients.id, id), isNull(patients.deletedAt)))
      .limit(1),
  );
  return row ? ok(row) : notFound();
}

export async function updatePatient(
  ctx: ServiceContext,
  id: string,
  raw: unknown,
): Promise<Result<{ changedFields: string[] }>> {
  if (!can(ctx.role, "patient.write")) return fail("forbidden", "You cannot edit patients.");
  if (!isUuid(id)) return notFound();
  const parsed = patientInputSchema.safeParse(raw);
  if (!parsed.success) return invalidFrom(parsed.error);
  const next = toColumns(parsed.data);

  return withTenant(ctx.tenantId, async (tx) => {
    const [existing] = await tx
      .select()
      .from(patients)
      .where(and(eq(patients.id, id), isNull(patients.deletedAt)))
      .limit(1);
    if (!existing) return notFound();

    const current = {
      name: existing.name,
      phone: existing.phone ?? null,
      gender: existing.gender ?? "unknown",
      dob: existing.dob ?? null,
      address: existing.address ?? null,
      allergies: existing.allergies ?? [],
      notes: existing.notes ?? null,
    };
    const proposed = {
      name: next.name,
      phone: next.phone,
      gender: next.gender,
      dob: next.dob,
      address: next.address,
      allergies: next.allergies,
      notes: next.notes,
    };
    const changedFields = (Object.keys(proposed) as (keyof typeof proposed)[]).filter(
      (key) => JSON.stringify(proposed[key]) !== JSON.stringify(current[key]),
    );
    if (changedFields.length === 0) return ok({ changedFields });

    await tx.update(patients).set(next).where(eq(patients.id, id));
    await recordAudit(tx, ctx, {
      action: "patient.updated",
      entityType: "patient",
      entityId: id,
      after: { changedFields },
    });
    return ok({ changedFields });
  });
}

export async function archivePatient(ctx: ServiceContext, id: string): Promise<Result<null>> {
  if (!can(ctx.role, "patient.archive")) return fail("forbidden", "Only the clinic owner can archive patients.");
  if (!isUuid(id)) return notFound();
  return withTenant(ctx.tenantId, async (tx) => {
    const archived = await tx
      .update(patients)
      .set({ deletedAt: new Date() })
      .where(and(eq(patients.id, id), isNull(patients.deletedAt)))
      .returning({ id: patients.id });
    if (archived.length === 0) return notFound();
    await recordAudit(tx, ctx, { action: "patient.archived", entityType: "patient", entityId: id });
    return ok(null);
  });
}
```

- [ ] **Step 5: Run tests and typecheck**

```powershell
npm run test -- tests/integration/patients.test.ts
npm run typecheck
```

Expected: PASS; typecheck exits 0. If the `"%"` or `"_"` search tests fail, the wildcard escaping is wrong; do not loosen the tests. If a test depends on exact ordering of `names("")`, remember empty queries are ordered newest first and the count assertions only depend on the four non-archived patients created in `beforeAll`.

- [ ] **Step 6: Commit**

```powershell
git add src/server tests/integration/patients.test.ts
git commit -m "feat: add patient service with search, duplicate warning, and audit"
```

---

## Task 5: Patient UI (list, search, register, edit)

**Files:**
- Create: `src/server/actions/patients.ts`, `src/components/patients/patient-form.tsx`, `src/app/(app)/patients/new/page.tsx`, `src/app/(app)/patients/[id]/page.tsx`, `tests/e2e/helpers.ts`, `tests/e2e/patients.spec.ts`
- Modify: `src/app/(app)/patients/page.tsx`

**Interfaces:**
- Consumes: Task 4 services, `requireSession()`, `can`, `ageLabel`.
- Produces: routes `/patients`, `/patients/new`, `/patients/[id]`; `type PatientFormState`, `createPatientAction`, `updatePatientAction(id, prev, formData)`; e2e helpers `registerClinic(page)` and `cleanupClinic(email)`.

- [ ] **Step 1: Write the failing e2e helper and spec**

`tests/e2e/helpers.ts`:

```ts
import { expect, type Page } from "@playwright/test";
import postgres from "postgres";

const adminUrl = process.env.ADMIN_DATABASE_URL ?? process.env.DIRECT_URL;

export type Clinic = { email: string; password: string; clinicName: string };

/** Signs up a fresh clinic through the UI and lands on the dashboard as its owner. */
export async function registerClinic(page: Page, label: string): Promise<Clinic> {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const clinic: Clinic = {
    email: `${label}-${stamp}@example.com`,
    password: "ClinicPad!2026",
    clinicName: `${label} Clinic ${stamp}`,
  };
  await page.goto("/signup");
  await page.getByLabel("Clinic name").fill(clinic.clinicName);
  await page.getByLabel("Your name").fill("Dr. E2E Tester");
  await page.getByLabel("Email").fill(clinic.email);
  await page.getByLabel("Phone").fill(`9${stamp.slice(-9)}`);
  await page.getByLabel("Password").fill(clinic.password);
  await page.getByRole("button", { name: /create clinic/i }).click();
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 30_000 });
  return clinic;
}

/** Removes the clinic (cascades to patients, prescriptions, audit) and its user. */
export async function cleanupClinic(email: string): Promise<void> {
  if (!adminUrl) return;
  const sql = postgres(adminUrl, { max: 1 });
  try {
    await sql`delete from tenants where id in (
      select m.tenant_id from memberships m join users u on u.id = m.user_id where u.email = ${email}
    )`;
    await sql`delete from users where email = ${email}`;
  } finally {
    await sql.end();
  }
}
```

`tests/e2e/patients.spec.ts`:

```ts
import { expect, test } from "@playwright/test";
import { cleanupClinic, registerClinic, type Clinic } from "./helpers";

let clinic: Clinic;

test.afterAll(async () => {
  if (clinic) await cleanupClinic(clinic.email);
});

test("register, find, warn on duplicate phone, and edit a patient", async ({ page }) => {
  clinic = await registerClinic(page, "pat");

  // Empty state.
  await page.getByRole("link", { name: "Patients" }).click();
  await expect(page.getByText(/no patients yet/i)).toBeVisible();

  // Register.
  await page.getByRole("link", { name: /new patient/i }).click();
  await page.getByLabel("Name").fill("Asha Rao");
  await page.getByLabel("Phone").fill("+91 98765 43210");
  await page.getByLabel("Gender").selectOption("female");
  await page.getByLabel("Date of birth").fill("1990-04-02");
  await page.getByLabel("Allergies").fill("Penicillin, Sulfa");
  await page.getByRole("button", { name: /register patient/i }).click();
  await expect(page).toHaveURL(/\/patients\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { name: "Asha Rao" })).toBeVisible();
  await expect(page.getByText("Penicillin")).toBeVisible();

  // Duplicate phone in another format -> warning, then confirm.
  await page.goto("/patients/new");
  await page.getByLabel("Name").fill("Meera Rao");
  await page.getByLabel("Phone").fill("9876543210");
  await page.getByRole("button", { name: /register patient/i }).click();
  await expect(page.getByText(/already exists/i)).toBeVisible();
  await expect(page.getByRole("link", { name: /Asha Rao/ })).toBeVisible();
  await page.getByRole("button", { name: /register anyway/i }).click();
  await expect(page.getByRole("heading", { name: "Meera Rao" })).toBeVisible();

  // Search by phone finds both; unknown term shows the no-match state.
  await page.goto("/patients?q=98765");
  await expect(page.getByRole("link", { name: "Asha Rao" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Meera Rao" })).toBeVisible();
  await page.goto("/patients?q=zzzz");
  await expect(page.getByText(/no patients match/i)).toBeVisible();

  // Edit.
  await page.goto("/patients?q=Meera");
  await page.getByRole("link", { name: "Meera Rao" }).click();
  await page.getByLabel("Name").fill("Meera Shah");
  await page.getByRole("button", { name: /save changes/i }).click();
  await expect(page.getByRole("heading", { name: "Meera Shah" })).toBeVisible();

  // A malformed id is a clean 404, not a crash.
  await page.goto("/patients/not-a-uuid");
  await expect(page.getByText(/could not be found/i)).toBeVisible();
});

```

- [ ] **Step 2: Run to verify it fails**

```powershell
npm run test:e2e -- tests/e2e/patients.spec.ts
```

Expected: FAIL (no "no patients yet" state, no "New patient" link).

- [ ] **Step 3: Implement the server actions**

`src/server/actions/patients.ts`:

```ts
"use server";

import { redirect } from "next/navigation";
import { requireSession } from "@/server/auth/session";
import { createPatient, updatePatient, type DuplicateCandidate } from "@/server/services/patients";

export type PatientFormValues = Record<string, string>;

export type PatientFormState = {
  error?: string;
  field?: string;
  candidates?: DuplicateCandidate[];
  values?: PatientFormValues;
};

const FIELDS = ["name", "phone", "gender", "dob", "address", "allergies", "notes"] as const;

function readValues(formData: FormData): PatientFormValues {
  const values: PatientFormValues = {};
  for (const field of FIELDS) values[field] = String(formData.get(field) ?? "");
  return values;
}

export async function createPatientAction(
  _prev: PatientFormState,
  formData: FormData,
): Promise<PatientFormState> {
  const session = await requireSession();
  const values = readValues(formData);
  const result = await createPatient(session, values, {
    allowDuplicate: formData.get("confirmDuplicate") === "yes",
  });
  if (!result.ok) {
    if (result.code === "duplicate_candidates") {
      return { error: result.message, candidates: result.candidates, values };
    }
    return { error: result.message, field: result.field, values };
  }
  redirect(`/patients/${result.value.id}`);
}

export async function updatePatientAction(
  id: string,
  _prev: PatientFormState,
  formData: FormData,
): Promise<PatientFormState> {
  const session = await requireSession();
  const values = readValues(formData);
  const result = await updatePatient(session, id, values);
  if (!result.ok) return { error: result.message, field: result.field, values };
  redirect(`/patients/${id}`);
}
```

- [ ] **Step 4: Implement the shared form**

`src/components/patients/patient-form.tsx`:

```tsx
"use client";

import Link from "next/link";
import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { PatientFormState, PatientFormValues } from "@/server/actions/patients";

type Props = {
  action: (prev: PatientFormState, formData: FormData) => Promise<PatientFormState>;
  initial?: PatientFormValues;
  submitLabel: string;
  /** Show the "register anyway" button when the server reports duplicate candidates. */
  allowDuplicateConfirm?: boolean;
};

const selectClass =
  "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm";

export function PatientForm({ action, initial, submitLabel, allowDuplicateConfirm }: Props) {
  const [state, formAction, pending] = useActionState(action, {} as PatientFormState);
  const v = state.values ?? initial ?? {};

  return (
    <form action={formAction} className="max-w-xl space-y-4">
      <div className="space-y-2">
        <Label htmlFor="name">Name</Label>
        <Input id="name" name="name" required minLength={2} defaultValue={v.name ?? ""} />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="phone">Phone</Label>
          <Input id="phone" name="phone" type="tel" autoComplete="off" defaultValue={v.phone ?? ""} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="gender">Gender</Label>
          <select id="gender" name="gender" className={selectClass} defaultValue={v.gender || "unknown"}>
            <option value="unknown">Not stated</option>
            <option value="female">Female</option>
            <option value="male">Male</option>
            <option value="other">Other</option>
          </select>
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="dob">Date of birth</Label>
          <Input id="dob" name="dob" type="date" defaultValue={v.dob ?? ""} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="allergies">Allergies</Label>
          <Input
            id="allergies"
            name="allergies"
            placeholder="Comma separated"
            defaultValue={v.allergies ?? ""}
          />
        </div>
      </div>
      <div className="space-y-2">
        <Label htmlFor="address">Address</Label>
        <Input id="address" name="address" defaultValue={v.address ?? ""} />
      </div>
      <div className="space-y-2">
        <Label htmlFor="notes">Notes</Label>
        <Textarea id="notes" name="notes" rows={3} defaultValue={v.notes ?? ""} />
      </div>

      {state.error ? (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      ) : null}

      {state.candidates?.length ? (
        <div className="space-y-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm">
          <p className="font-medium">Possible existing patients with this phone number:</p>
          <ul className="list-disc pl-5">
            {state.candidates.map((c) => (
              <li key={c.id}>
                <Link className="underline" href={`/patients/${c.id}`} target="_blank">
                  {c.name}
                </Link>
                {c.patientNo ? ` (#${c.patientNo})` : ""}
                {c.sameName ? " — same name" : ""}
              </li>
            ))}
          </ul>
          {allowDuplicateConfirm ? (
            <Button type="submit" name="confirmDuplicate" value="yes" variant="outline" disabled={pending}>
              Register anyway — this is a different person
            </Button>
          ) : null}
        </div>
      ) : null}

      <Button type="submit" disabled={pending}>
        {pending ? "Saving…" : submitLabel}
      </Button>
    </form>
  );
}
```

- [ ] **Step 5: Implement the pages**

`src/app/(app)/patients/page.tsx` (replace):

```tsx
import Link from "next/link";
import { redirect } from "next/navigation";
import { requireSession } from "@/server/auth/session";
import { can } from "@/lib/domain/permissions";
import { ageLabel } from "@/lib/domain/age";
import { searchPatients } from "@/server/services/patients";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export const dynamic = "force-dynamic";

export default async function PatientsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const session = await requireSession();
  if (!can(session.role, "patient.read")) redirect("/dashboard");

  const { q } = await searchParams;
  const result = await searchPatients(session, { q });
  const rows = result.ok ? result.value : [];
  const now = new Date();

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Patients</h1>
        {can(session.role, "patient.write") ? (
          <Button asChild>
            <Link href="/patients/new">New patient</Link>
          </Button>
        ) : null}
      </header>

      <form method="get" className="flex max-w-md gap-2" role="search">
        <Input name="q" defaultValue={q ?? ""} placeholder="Search name, phone, or patient number" aria-label="Search patients" />
        <Button type="submit" variant="outline">
          Search
        </Button>
      </form>

      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {q ? "No patients match that search." : "No patients yet. Register your first patient to get started."}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="p-3">#</th>
                <th className="p-3">Name</th>
                <th className="p-3">Phone</th>
                <th className="p-3">Age</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {rows.map((p) => (
                <tr key={p.id}>
                  <td className="p-3 text-muted-foreground">{p.patientNo ?? "—"}</td>
                  <td className="p-3">
                    <Link className="font-medium underline-offset-2 hover:underline" href={`/patients/${p.id}`}>
                      {p.name}
                    </Link>
                  </td>
                  <td className="p-3">{p.phone ?? "—"}</td>
                  <td className="p-3">{p.dob ? ageLabel(p.dob, now) || "—" : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
```

`src/app/(app)/patients/new/page.tsx`:

```tsx
import { redirect } from "next/navigation";
import { requireSession } from "@/server/auth/session";
import { can } from "@/lib/domain/permissions";
import { createPatientAction } from "@/server/actions/patients";
import { PatientForm } from "@/components/patients/patient-form";

export default async function NewPatientPage() {
  const session = await requireSession();
  if (!can(session.role, "patient.write")) redirect("/patients");

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">New patient</h1>
      <PatientForm action={createPatientAction} submitLabel="Register patient" allowDuplicateConfirm />
    </div>
  );
}
```

`src/app/(app)/patients/[id]/page.tsx`:

```tsx
import { notFound, redirect } from "next/navigation";
import { requireSession } from "@/server/auth/session";
import { can } from "@/lib/domain/permissions";
import { ageLabel } from "@/lib/domain/age";
import { getPatient } from "@/server/services/patients";
import { updatePatientAction } from "@/server/actions/patients";
import { PatientForm } from "@/components/patients/patient-form";

export const dynamic = "force-dynamic";

export default async function PatientPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!can(session.role, "patient.read")) redirect("/dashboard");

  const { id } = await params;
  const result = await getPatient(session, id);
  if (!result.ok) notFound();
  const p = result.value;
  const age = p.dob ? ageLabel(p.dob, new Date()) : "";

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">{p.name}</h1>
        <p className="text-sm text-muted-foreground">
          {[p.patientNo ? `Patient #${p.patientNo}` : null, age, p.gender && p.gender !== "unknown" ? p.gender : null, p.phone]
            .filter(Boolean)
            .join(" · ")}
        </p>
        {p.allergies?.length ? (
          <p className="mt-2 inline-block rounded bg-red-50 px-2 py-1 text-sm text-red-800">
            Allergies: {p.allergies.join(", ")}
          </p>
        ) : null}
      </header>

      {can(session.role, "patient.write") ? (
        <section className="space-y-3">
          <h2 className="font-medium">Details</h2>
          <PatientForm
            action={updatePatientAction.bind(null, p.id)}
            submitLabel="Save changes"
            initial={{
              name: p.name,
              phone: p.phone ?? "",
              gender: p.gender ?? "unknown",
              dob: p.dob ?? "",
              address: p.address ?? "",
              allergies: (p.allergies ?? []).join(", "),
              notes: p.notes ?? "",
            }}
          />
        </section>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 6: Run the e2e spec, typecheck, and lint**

```powershell
npm run test:e2e -- tests/e2e/patients.spec.ts
npm run typecheck
npm run lint
```

Expected: both e2e tests PASS; typecheck exits 0; lint has 0 errors. If `getByLabel("Name")` is ambiguous in a failure, the cause is another field whose label contains "Name": keep labels exactly as above.

- [ ] **Step 7: Commit**

```powershell
git add src tests/e2e
git commit -m "feat: add patient list, search, registration, and editing"
```

---

## Task 6: Prescription draft service

**Files:**
- Create: `src/server/validation/prescription.ts`, `src/server/services/prescriptions.ts`
- Test: `tests/integration/prescriptions-draft.test.ts`

**Interfaces:**
- Consumes: Task 3 plumbing; Task 4 `createPatient`, `archivePatient`.
- Produces:
  - `draftInputSchema`; `type DraftInput = z.output<typeof draftInputSchema>`.
  - `startPrescription(ctx, input: { patientId: string }): Promise<Result<{ prescriptionId: string }>>`.
  - `getPrescription(ctx, id: string): Promise<Result<PrescriptionView>>`.
  - `saveDraft(ctx, id: string, raw: unknown): Promise<Result<{ savedAt: Date }>>`.
  - `listPrescriptionsForPatient(ctx, patientId: string): Promise<Result<PrescriptionSummary[]>>`.
  - `type ItemView = { drugName: string; strength: string | null; form: string | null; route: string | null; dose: string | null; timing: string | null; foodRelation: string | null; durationDays: number | null; remarks: string | null }`.
  - `type PrescriptionView = { id: string; status: string; version: number; rxNo: number | null; amendmentReason: string | null; parentPrescriptionId: string | null; finalizedAt: Date | null; patient: { id: string; name: string; patientNo: number | null }; visit: { id: string; visitType: string; chiefComplaint: string | null; diagnosis: string[]; advice: string | null; followUpDate: string | null }; items: ItemView[] }`.
  - `type PrescriptionSummary = { id: string; rxNo: number | null; version: number; status: string; chiefComplaint: string | null; createdAt: Date; finalizedAt: Date | null }`.

- [ ] **Step 1: Write the failing tests**

`tests/integration/prescriptions-draft.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { withTenant } from "@/server/db/tenant";
import { auditEvents } from "@/server/db/schema";
import { archivePatient, createPatient } from "@/server/services/patients";
import {
  getPrescription,
  listPrescriptionsForPatient,
  saveDraft,
  startPrescription,
} from "@/server/services/prescriptions";
import { newId } from "@/lib/domain/ids";
import { createTestTenant, type TestTenant } from "../helpers/tenant";

let A: TestTenant;
let B: TestTenant;
let patientId = "";

const draft = (items: Record<string, unknown>[] = [{ drugName: "Paracetamol", dose: "1 tablet", timing: "TDS", durationDays: 3 }]) => ({
  visitType: "new",
  chiefComplaint: "Fever for 2 days",
  diagnosis: ["Viral fever"],
  advice: "Rest and fluids",
  followUpDate: "2026-12-01",
  items,
});

beforeAll(async () => {
  A = await createTestTenant("rxda");
  B = await createTestTenant("rxdb");
  const p = await createPatient(A.as("reception"), { name: "Draft Patient" });
  if (!p.ok) throw new Error(p.message);
  patientId = p.value.id;
});
afterAll(async () => {
  await A.cleanup();
  await B.cleanup();
});

async function start(ctx = A.as("doctor")) {
  const r = await startPrescription(ctx, { patientId });
  if (!r.ok) throw new Error(r.message);
  return r.value.prescriptionId;
}

describe("startPrescription", () => {
  it("creates an empty draft with no Rx number and an audit event", async () => {
    const id = await start();
    const got = await getPrescription(A.as("doctor"), id);
    expect(got).toMatchObject({
      ok: true,
      value: { status: "draft", version: 1, rxNo: null, items: [], patient: { name: "Draft Patient" } },
    });
    const audit = await withTenant(A.tenantId, (tx) =>
      tx.select().from(auditEvents).where(eq(auditEvents.entityId, id)),
    );
    expect(audit.map((e) => e.action)).toEqual(["prescription.drafted"]);
  });

  it.each(["reception", "nurse", "accountant", "pharmacist"])("forbids %s from starting one", async (role) => {
    expect(await startPrescription(A.as(role), { patientId })).toMatchObject({ ok: false, code: "forbidden" });
  });

  it("returns not_found for unknown, malformed, other-clinic, and archived patients", async () => {
    expect(await startPrescription(A.as("doctor"), { patientId: newId() })).toMatchObject({ ok: false, code: "not_found" });
    expect(await startPrescription(A.as("doctor"), { patientId: "nope" })).toMatchObject({ ok: false, code: "not_found" });
    expect(await startPrescription(B.as("doctor"), { patientId })).toMatchObject({ ok: false, code: "not_found" });

    const gone = await createPatient(A.as("owner"), { name: "Soon Archived" });
    if (!gone.ok) throw new Error(gone.message);
    await archivePatient(A.as("owner"), gone.value.id);
    expect(await startPrescription(A.as("doctor"), { patientId: gone.value.id })).toMatchObject({
      ok: false,
      code: "not_found",
    });
  });
});

describe("saveDraft", () => {
  it("stores visit fields and items in order, and replaces them on the next save", async () => {
    const id = await start();
    const saved = await saveDraft(
      A.as("doctor"),
      id,
      draft([
        { drugName: "Paracetamol", strength: "500 mg", dose: "1 tablet", timing: "TDS", durationDays: 3 },
        { drugName: "Cetirizine", timing: "HS", durationDays: null },
      ]),
    );
    expect(saved.ok).toBe(true);

    const first = await getPrescription(A.as("doctor"), id);
    if (!first.ok) throw new Error(first.message);
    expect(first.value.visit).toMatchObject({
      chiefComplaint: "Fever for 2 days",
      diagnosis: ["Viral fever"],
      followUpDate: "2026-12-01",
    });
    expect(first.value.items.map((i) => i.drugName)).toEqual(["Paracetamol", "Cetirizine"]);
    expect(first.value.items[0]).toMatchObject({ strength: "500 mg", durationDays: 3 });

    await saveDraft(A.as("doctor"), id, draft([{ drugName: "Azithromycin" }]));
    const second = await getPrescription(A.as("doctor"), id);
    expect(second.ok && second.value.items.map((i) => i.drugName)).toEqual(["Azithromycin"]);
  });

  it("allows saving an empty draft and treats blank strings as absent", async () => {
    const id = await start();
    const saved = await saveDraft(A.as("doctor"), id, {
      chiefComplaint: "",
      advice: "",
      followUpDate: "",
      items: [{ drugName: "Paracetamol", strength: "", dose: "", durationDays: null }],
    });
    expect(saved.ok).toBe(true);
    const got = await getPrescription(A.as("doctor"), id);
    expect(got.ok && got.value.items[0].strength).toBeNull();
  });

  it.each([
    [{ items: [{ drugName: "" }] }, "items"],
    [{ items: [{ drugName: "X", durationDays: 0 }] }, "items"],
    [{ items: [{ drugName: "X", durationDays: 1000 }] }, "items"],
    [{ items: Array.from({ length: 31 }, () => ({ drugName: "X" })) }, "items"],
    [{ followUpDate: "tomorrow" }, "followUpDate"],
    [{ visitType: "surgery" }, "visitType"],
  ])("rejects invalid input %j", async (input, field) => {
    const id = await start();
    expect(await saveDraft(A.as("doctor"), id, input)).toMatchObject({ ok: false, code: "invalid", field });
  });

  it("is denied to roles that cannot draft, and hidden from other clinics", async () => {
    const id = await start();
    expect(await saveDraft(A.as("reception"), id, draft())).toMatchObject({ ok: false, code: "forbidden" });
    expect(await saveDraft(B.as("doctor"), id, draft())).toMatchObject({ ok: false, code: "not_found" });
    expect(await saveDraft(A.as("doctor"), "not-a-uuid", draft())).toMatchObject({ ok: false, code: "not_found" });
  });
});

describe("getPrescription", () => {
  it("lets reception and nurses read, denies accountants, and hides other clinics' records", async () => {
    const id = await start();
    expect((await getPrescription(A.as("reception"), id)).ok).toBe(true);
    expect((await getPrescription(A.as("nurse"), id)).ok).toBe(true);
    expect(await getPrescription(A.as("accountant"), id)).toMatchObject({ ok: false, code: "forbidden" });
    expect(await getPrescription(B.as("owner"), id)).toMatchObject({ ok: false, code: "not_found" });
    expect(await getPrescription(A.as("owner"), "x")).toMatchObject({ ok: false, code: "not_found" });
  });
});

describe("listPrescriptionsForPatient", () => {
  it("lists a patient's prescriptions newest first and hides other clinics", async () => {
    const p = await createPatient(A.as("owner"), { name: "List Patient" });
    if (!p.ok) throw new Error(p.message);
    const a = await startPrescription(A.as("doctor"), { patientId: p.value.id });
    const b = await startPrescription(A.as("doctor"), { patientId: p.value.id });
    if (!a.ok || !b.ok) throw new Error("setup failed");

    const list = await listPrescriptionsForPatient(A.as("reception"), p.value.id);
    expect(list.ok && list.value.map((r) => r.id)).toEqual([b.value.prescriptionId, a.value.prescriptionId]);
    expect(await listPrescriptionsForPatient(B.as("owner"), p.value.id)).toMatchObject({ ok: false, code: "not_found" });
    expect(await listPrescriptionsForPatient(A.as("accountant"), p.value.id)).toMatchObject({ ok: false, code: "forbidden" });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```powershell
npm run test -- tests/integration/prescriptions-draft.test.ts
```

Expected: FAIL — module missing.

- [ ] **Step 3: Implement the validation schema**

`src/server/validation/prescription.ts`:

```ts
import { z } from "zod";

const blankToUndefined = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

const optionalText = (max: number) =>
  z.preprocess(blankToUndefined, z.string().trim().max(max).optional());

export const prescriptionItemSchema = z.object({
  drugName: z.string().trim().min(1, "Enter the medicine name").max(200),
  strength: optionalText(60),
  form: optionalText(40),
  route: optionalText(40),
  dose: optionalText(60),
  timing: optionalText(60),
  foodRelation: optionalText(40),
  durationDays: z.number().int().min(1, "Duration must be at least 1 day").max(365, "Duration cannot exceed 365 days").nullish(),
  remarks: optionalText(300),
});

export const draftInputSchema = z.object({
  visitType: z.enum(["new", "follow-up"]).default("new"),
  chiefComplaint: optionalText(500),
  diagnosis: z.array(z.string().trim().min(1).max(200)).max(20).default([]),
  advice: optionalText(2000),
  followUpDate: z.preprocess(
    blankToUndefined,
    z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Use the format YYYY-MM-DD")
      .refine((v) => {
        const d = new Date(`${v}T00:00:00Z`);
        return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
      }, "Enter a real date")
      .optional(),
  ),
  items: z.array(prescriptionItemSchema).max(30, "A prescription can have at most 30 medicines").default([]),
});

export type DraftInput = z.output<typeof draftInputSchema>;
export type DraftItemInput = z.output<typeof prescriptionItemSchema>;
```

- [ ] **Step 4: Implement the service (draft half)**

`src/server/services/prescriptions.ts`:

```ts
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { fail, invalidFrom, ok, type Result } from "@/lib/result";
import { can } from "@/lib/domain/permissions";
import { isUuid } from "@/lib/domain/ids";
import { doctors, patients, prescriptionItems, prescriptions, visits } from "@/server/db/schema";
import { withTenant, type TenantTx } from "@/server/db/tenant";
import { draftInputSchema, type DraftItemInput } from "@/server/validation/prescription";
import type { ServiceContext } from "./context";
import { recordAudit } from "./audit";

export type ItemView = {
  drugName: string;
  strength: string | null;
  form: string | null;
  route: string | null;
  dose: string | null;
  timing: string | null;
  foodRelation: string | null;
  durationDays: number | null;
  remarks: string | null;
};

export type PrescriptionView = {
  id: string;
  status: string;
  version: number;
  rxNo: number | null;
  amendmentReason: string | null;
  parentPrescriptionId: string | null;
  finalizedAt: Date | null;
  patient: { id: string; name: string; patientNo: number | null };
  visit: {
    id: string;
    visitType: string;
    chiefComplaint: string | null;
    diagnosis: string[];
    advice: string | null;
    followUpDate: string | null;
  };
  items: ItemView[];
};

export type PrescriptionSummary = {
  id: string;
  rxNo: number | null;
  version: number;
  status: string;
  chiefComplaint: string | null;
  createdAt: Date;
  finalizedAt: Date | null;
};

const prescriptionNotFound = () => fail("not_found", "Prescription not found.");
const patientNotFound = () => fail("not_found", "Patient not found.");

async function doctorIdFor(tx: TenantTx, userId: string): Promise<string | null> {
  const [doctor] = await tx.select({ id: doctors.id }).from(doctors).where(eq(doctors.userId, userId)).limit(1);
  return doctor?.id ?? null;
}

/** Copies items (used by amend and repeat). Items are inserted while the target is a draft. */
export async function copyItems(
  tx: TenantTx,
  ctx: ServiceContext,
  fromPrescriptionId: string,
  toPrescriptionId: string,
): Promise<void> {
  const rows = await tx
    .select()
    .from(prescriptionItems)
    .where(eq(prescriptionItems.prescriptionId, fromPrescriptionId))
    .orderBy(asc(prescriptionItems.sortOrder));
  if (rows.length === 0) return;
  await tx.insert(prescriptionItems).values(
    rows.map((r) => ({
      tenantId: ctx.tenantId,
      prescriptionId: toPrescriptionId,
      sortOrder: r.sortOrder,
      drugName: r.drugName,
      strength: r.strength,
      form: r.form,
      route: r.route,
      dose: r.dose,
      timing: r.timing,
      foodRelation: r.foodRelation,
      durationDays: r.durationDays,
      remarks: r.remarks,
    })),
  );
}

export async function startPrescription(
  ctx: ServiceContext,
  input: { patientId: string },
): Promise<Result<{ prescriptionId: string }>> {
  if (!can(ctx.role, "rx.draft")) return fail("forbidden", "Only doctors can write prescriptions.");
  if (!isUuid(input.patientId)) return patientNotFound();

  return withTenant(ctx.tenantId, async (tx) => {
    const [patient] = await tx
      .select({ id: patients.id })
      .from(patients)
      .where(and(eq(patients.id, input.patientId), isNull(patients.deletedAt)))
      .limit(1);
    if (!patient) return patientNotFound();

    const [visit] = await tx
      .insert(visits)
      .values({
        tenantId: ctx.tenantId,
        patientId: patient.id,
        doctorId: await doctorIdFor(tx, ctx.userId),
        status: "draft",
        visitType: "new",
      })
      .returning({ id: visits.id });
    const [rx] = await tx
      .insert(prescriptions)
      .values({ tenantId: ctx.tenantId, visitId: visit.id, status: "draft", version: 1 })
      .returning({ id: prescriptions.id });
    await recordAudit(tx, ctx, {
      action: "prescription.drafted",
      entityType: "prescription",
      entityId: rx.id,
      after: { version: 1 },
    });
    return ok({ prescriptionId: rx.id });
  });
}

export async function getPrescription(ctx: ServiceContext, id: string): Promise<Result<PrescriptionView>> {
  if (!can(ctx.role, "rx.read")) return fail("forbidden", "You cannot view prescriptions.");
  if (!isUuid(id)) return prescriptionNotFound();

  return withTenant(ctx.tenantId, async (tx) => {
    const [row] = await tx
      .select({
        rx: prescriptions,
        visit: visits,
        patient: { id: patients.id, name: patients.name, patientNo: patients.patientNo },
      })
      .from(prescriptions)
      .innerJoin(visits, eq(visits.id, prescriptions.visitId))
      .innerJoin(patients, eq(patients.id, visits.patientId))
      .where(eq(prescriptions.id, id))
      .limit(1);
    if (!row) return prescriptionNotFound();

    const items = await tx
      .select()
      .from(prescriptionItems)
      .where(eq(prescriptionItems.prescriptionId, id))
      .orderBy(asc(prescriptionItems.sortOrder));

    return ok<PrescriptionView>({
      id: row.rx.id,
      status: row.rx.status,
      version: row.rx.version,
      rxNo: row.rx.rxNo,
      amendmentReason: row.rx.amendmentReason,
      parentPrescriptionId: row.rx.parentPrescriptionId,
      finalizedAt: row.rx.finalizedAt,
      patient: row.patient,
      visit: {
        id: row.visit.id,
        visitType: row.visit.visitType,
        chiefComplaint: row.visit.chiefComplaint,
        diagnosis: row.visit.diagnosis ?? [],
        advice: row.visit.advice,
        followUpDate: row.visit.followUpDate,
      },
      items: items.map((i) => ({
        drugName: i.drugName,
        strength: i.strength,
        form: i.form,
        route: i.route,
        dose: i.dose,
        timing: i.timing,
        foodRelation: i.foodRelation,
        durationDays: i.durationDays,
        remarks: i.remarks,
      })),
    });
  });
}

function itemValues(ctx: ServiceContext, prescriptionId: string, items: DraftItemInput[]) {
  return items.map((item, index) => ({
    tenantId: ctx.tenantId,
    prescriptionId,
    sortOrder: index,
    drugName: item.drugName,
    strength: item.strength ?? null,
    form: item.form ?? null,
    route: item.route ?? null,
    dose: item.dose ?? null,
    timing: item.timing ?? null,
    foodRelation: item.foodRelation ?? null,
    durationDays: item.durationDays ?? null,
    remarks: item.remarks ?? null,
  }));
}

export async function saveDraft(
  ctx: ServiceContext,
  id: string,
  raw: unknown,
): Promise<Result<{ savedAt: Date }>> {
  if (!can(ctx.role, "rx.draft")) return fail("forbidden", "Only doctors can edit prescriptions.");
  if (!isUuid(id)) return prescriptionNotFound();
  const parsed = draftInputSchema.safeParse(raw);
  if (!parsed.success) return invalidFrom(parsed.error);
  const input = parsed.data;

  return withTenant(ctx.tenantId, async (tx) => {
    const [rx] = await tx
      .select({ id: prescriptions.id, status: prescriptions.status, visitId: prescriptions.visitId })
      .from(prescriptions)
      .where(eq(prescriptions.id, id))
      .limit(1)
      .for("update");
    if (!rx) return prescriptionNotFound();
    if (rx.status !== "draft") {
      return fail("immutable", "This prescription is finalized. Amend it to make changes.");
    }

    await tx
      .update(visits)
      .set({
        visitType: input.visitType,
        chiefComplaint: input.chiefComplaint ?? null,
        diagnosis: input.diagnosis,
        advice: input.advice ?? null,
        followUpDate: input.followUpDate ?? null,
      })
      .where(eq(visits.id, rx.visitId));
    await tx.delete(prescriptionItems).where(eq(prescriptionItems.prescriptionId, id));
    if (input.items.length > 0) {
      await tx.insert(prescriptionItems).values(itemValues(ctx, id, input.items));
    }
    const [saved] = await tx
      .update(prescriptions)
      .set({ updatedAt: new Date() })
      .where(eq(prescriptions.id, id))
      .returning({ updatedAt: prescriptions.updatedAt });
    return ok({ savedAt: saved.updatedAt });
  });
}

export async function listPrescriptionsForPatient(
  ctx: ServiceContext,
  patientId: string,
): Promise<Result<PrescriptionSummary[]>> {
  if (!can(ctx.role, "rx.read")) return fail("forbidden", "You cannot view prescriptions.");
  if (!isUuid(patientId)) return patientNotFound();

  return withTenant(ctx.tenantId, async (tx) => {
    const [patient] = await tx.select({ id: patients.id }).from(patients).where(eq(patients.id, patientId)).limit(1);
    if (!patient) return patientNotFound();

    const rows = await tx
      .select({
        id: prescriptions.id,
        rxNo: prescriptions.rxNo,
        version: prescriptions.version,
        status: prescriptions.status,
        chiefComplaint: visits.chiefComplaint,
        createdAt: prescriptions.createdAt,
        finalizedAt: prescriptions.finalizedAt,
      })
      .from(prescriptions)
      .innerJoin(visits, eq(visits.id, prescriptions.visitId))
      .where(eq(visits.patientId, patientId))
      .orderBy(desc(prescriptions.createdAt), desc(prescriptions.id));
    return ok(rows);
  });
}
```

Note on ordering in the list test: two drafts created back to back can share a `created_at` only if the clock does not advance between inserts; the secondary `desc(prescriptions.id)` sort uses UUIDv7 ids, which are time-ordered, so the newest still sorts first.

- [ ] **Step 5: Run tests and typecheck**

```powershell
npm run test -- tests/integration/prescriptions-draft.test.ts
npm run typecheck
```

Expected: PASS; typecheck exits 0.

- [ ] **Step 6: Commit**

```powershell
git add src/server tests/integration/prescriptions-draft.test.ts
git commit -m "feat: add prescription draft service (start, save, read, list)"
```

---

## Task 7: Finalize, amend, and repeat

**Files:**
- Modify: `src/server/services/prescriptions.ts`
- Test: `tests/integration/prescriptions-lifecycle.test.ts`

**Interfaces:**
- Consumes: Task 6 service, `allocateNumber`, `pgErrorInfo`.
- Produces:
  - `finalizePrescription(ctx, id: string): Promise<Result<{ rxNo: number; version: number }>>`.
  - `amendPrescription(ctx, input: { prescriptionId: string; reason: string }): Promise<Result<{ prescriptionId: string; version: number }>>`.
  - `repeatPrescription(ctx, id: string): Promise<Result<{ prescriptionId: string }>>`.

- [ ] **Step 1: Write the failing tests**

`tests/integration/prescriptions-lifecycle.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { adminDb } from "@/server/db/admin";
import { withTenant } from "@/server/db/tenant";
import { pgErrorInfo } from "@/server/db/errors";
import { auditEvents, prescriptionItems, prescriptions, tenantCounters } from "@/server/db/schema";
import { createPatient } from "@/server/services/patients";
import {
  amendPrescription,
  finalizePrescription,
  getPrescription,
  repeatPrescription,
  saveDraft,
  startPrescription,
} from "@/server/services/prescriptions";
import { createTestTenant, type TestTenant } from "../helpers/tenant";

let A: TestTenant;
let B: TestTenant;
let patientId = "";

beforeAll(async () => {
  A = await createTestTenant("lifea");
  B = await createTestTenant("lifeb");
  const p = await createPatient(A.as("reception"), { name: "Lifecycle Patient" });
  if (!p.ok) throw new Error(p.message);
  patientId = p.value.id;
});
afterAll(async () => {
  await A.cleanup();
  await B.cleanup();
});

const doctor = () => A.as("doctor");

async function draftWithItem(drugName = "Paracetamol"): Promise<string> {
  const started = await startPrescription(doctor(), { patientId });
  if (!started.ok) throw new Error(started.message);
  const id = started.value.prescriptionId;
  const saved = await saveDraft(doctor(), id, {
    chiefComplaint: "Fever",
    diagnosis: ["Viral fever"],
    items: [{ drugName, dose: "1 tablet", timing: "TDS", durationDays: 3 }],
  });
  if (!saved.ok) throw new Error(saved.message);
  return id;
}

async function finalized(drugName?: string): Promise<{ id: string; rxNo: number }> {
  const id = await draftWithItem(drugName);
  const done = await finalizePrescription(doctor(), id);
  if (!done.ok) throw new Error(done.message);
  return { id, rxNo: done.value.rxNo };
}

describe("finalizePrescription", () => {
  it("refuses an empty prescription and assigns no number", async () => {
    const started = await startPrescription(doctor(), { patientId });
    if (!started.ok) throw new Error(started.message);
    const result = await finalizePrescription(doctor(), started.value.prescriptionId);
    expect(result).toMatchObject({ ok: false, code: "invalid", field: "items" });
    const got = await getPrescription(doctor(), started.value.prescriptionId);
    expect(got.ok && got.value.rxNo).toBeNull();
  });

  it("assigns sequential Rx numbers; abandoned drafts do not consume numbers", async () => {
    const first = await finalized();
    await draftWithItem(); // abandoned, never finalized
    await draftWithItem(); // abandoned
    const second = await finalized();
    expect(second.rxNo).toBe(first.rxNo + 1);
  });

  it("freezes the record and writes an audit event", async () => {
    const { id } = await finalized();
    const got = await getPrescription(doctor(), id);
    expect(got).toMatchObject({ ok: true, value: { status: "finalized", version: 1 } });

    expect(await saveDraft(doctor(), id, { items: [{ drugName: "Changed" }] })).toMatchObject({
      ok: false,
      code: "immutable",
    });

    const audit = await withTenant(A.tenantId, (tx) =>
      tx.select().from(auditEvents).where(eq(auditEvents.entityId, id)),
    );
    expect(audit.map((e) => e.action).sort()).toEqual(["prescription.drafted", "prescription.finalized"]);
  });

  it("cannot be bypassed with direct SQL, even as admin", async () => {
    const { id } = await finalized();
    const error = await adminDb
      .update(prescriptionItems)
      .set({ drugName: "Tampered" })
      .where(eq(prescriptionItems.prescriptionId, id))
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(pgErrorInfo(error).code).toBe("23000");
  });

  it("is idempotent under a double-click: exactly one success, one conflict, no burned number", async () => {
    const id = await draftWithItem();
    const before = await adminDb.select().from(tenantCounters).where(eq(tenantCounters.tenantId, A.tenantId));
    const beforeRx = before.find((c) => c.name === "rx")?.lastNo ?? 0;

    const [r1, r2] = await Promise.all([finalizePrescription(doctor(), id), finalizePrescription(doctor(), id)]);
    const results = [r1, r2];
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toMatchObject({ ok: false, code: "conflict" });

    const after = await adminDb.select().from(tenantCounters).where(eq(tenantCounters.tenantId, A.tenantId));
    expect(after.find((c) => c.name === "rx")?.lastNo).toBe(beforeRx + 1);
  });

  it.each(["reception", "nurse", "accountant", "pharmacist"])("forbids %s", async (role) => {
    const id = await draftWithItem();
    expect(await finalizePrescription(A.as(role), id)).toMatchObject({ ok: false, code: "forbidden" });
  });

  it("returns not_found for another clinic's or a malformed id", async () => {
    const id = await draftWithItem();
    expect(await finalizePrescription(B.as("doctor"), id)).toMatchObject({ ok: false, code: "not_found" });
    expect(await finalizePrescription(A.as("doctor"), "nope")).toMatchObject({ ok: false, code: "not_found" });
  });
});

describe("amendPrescription", () => {
  it("creates v2 as a draft with the same Rx number, copied items, and the reason", async () => {
    const { id, rxNo } = await finalized("Original Drug");
    const amended = await amendPrescription(doctor(), { prescriptionId: id, reason: "Wrong dose entered" });
    expect(amended).toMatchObject({ ok: true, value: { version: 2 } });
    if (!amended.ok) throw new Error();

    const v2 = await getPrescription(doctor(), amended.value.prescriptionId);
    expect(v2).toMatchObject({
      ok: true,
      value: {
        status: "draft",
        version: 2,
        rxNo,
        amendmentReason: "Wrong dose entered",
        parentPrescriptionId: id,
      },
    });
    expect(v2.ok && v2.value.items.map((i) => i.drugName)).toEqual(["Original Drug"]);
    expect(v2.ok && v2.value.visit.chiefComplaint).toBe("Fever");

    // v1 is untouched until v2 is finalized.
    const v1 = await getPrescription(doctor(), id);
    expect(v1).toMatchObject({ ok: true, value: { status: "finalized", version: 1 } });
  });

  it("finalizing v2 marks v1 amended, keeps the Rx number, and leaves v1's content intact", async () => {
    const { id, rxNo } = await finalized("Dose Error Drug");
    const amended = await amendPrescription(doctor(), { prescriptionId: id, reason: "Correct the drug" });
    if (!amended.ok) throw new Error(amended.message);
    const v2Id = amended.value.prescriptionId;

    await saveDraft(doctor(), v2Id, { chiefComplaint: "Fever", items: [{ drugName: "Corrected Drug" }] });
    const done = await finalizePrescription(doctor(), v2Id);
    expect(done).toMatchObject({ ok: true, value: { rxNo, version: 2 } });

    const v1 = await getPrescription(doctor(), id);
    expect(v1).toMatchObject({ ok: true, value: { status: "amended", version: 1 } });
    expect(v1.ok && v1.value.items.map((i) => i.drugName)).toEqual(["Dose Error Drug"]);

    const audit = await withTenant(A.tenantId, (tx) =>
      tx.select().from(auditEvents).where(eq(auditEvents.entityId, v2Id)),
    );
    expect(audit.map((e) => e.action).sort()).toEqual(["prescription.amended", "prescription.amendment_drafted"]);
  });

  it("allows only one open amendment, and none from an already-amended version", async () => {
    const { id } = await finalized();
    const first = await amendPrescription(doctor(), { prescriptionId: id, reason: "First amendment" });
    expect(first.ok).toBe(true);
    expect(await amendPrescription(doctor(), { prescriptionId: id, reason: "Second at once" })).toMatchObject({
      ok: false,
      code: "conflict",
    });

    if (!first.ok) throw new Error();
    await finalizePrescription(doctor(), first.value.prescriptionId);
    expect(await amendPrescription(doctor(), { prescriptionId: id, reason: "Amend the old one" })).toMatchObject({
      ok: false,
      code: "conflict",
    });
  });

  it("survives two simultaneous amend requests", async () => {
    const { id } = await finalized();
    const [r1, r2] = await Promise.all([
      amendPrescription(doctor(), { prescriptionId: id, reason: "Race one" }),
      amendPrescription(doctor(), { prescriptionId: id, reason: "Race two" }),
    ]);
    expect([r1, r2].filter((r) => r.ok)).toHaveLength(1);
    expect([r1, r2].find((r) => !r.ok)).toMatchObject({ ok: false, code: "conflict" });
  });

  it("rejects a draft, a missing/short reason, and unauthorized roles", async () => {
    const draftId = await draftWithItem();
    expect(await amendPrescription(doctor(), { prescriptionId: draftId, reason: "Not final yet" })).toMatchObject({
      ok: false,
      code: "conflict",
    });

    const { id } = await finalized();
    expect(await amendPrescription(doctor(), { prescriptionId: id, reason: "no" })).toMatchObject({
      ok: false,
      code: "invalid",
      field: "reason",
    });
    expect(await amendPrescription(doctor(), { prescriptionId: id, reason: "     " })).toMatchObject({
      ok: false,
      code: "invalid",
      field: "reason",
    });
    for (const role of ["reception", "nurse", "accountant"]) {
      expect(await amendPrescription(A.as(role), { prescriptionId: id, reason: "Valid reason here" })).toMatchObject({
        ok: false,
        code: "forbidden",
      });
    }
    expect(await amendPrescription(B.as("doctor"), { prescriptionId: id, reason: "Valid reason here" })).toMatchObject({
      ok: false,
      code: "not_found",
    });
  });

  it("leaves a deletable tenant: parent and child versions cascade away with the clinic", async () => {
    const T = await createTestTenant("cascade");
    const p = await createPatient(T.as("owner"), { name: "Cascade Patient" });
    if (!p.ok) throw new Error(p.message);
    const s = await startPrescription(T.as("doctor"), { patientId: p.value.id });
    if (!s.ok) throw new Error(s.message);
    await saveDraft(T.as("doctor"), s.value.prescriptionId, { items: [{ drugName: "X" }] });
    await finalizePrescription(T.as("doctor"), s.value.prescriptionId);
    const a = await amendPrescription(T.as("doctor"), { prescriptionId: s.value.prescriptionId, reason: "Cascade check" });
    if (!a.ok) throw new Error(a.message);
    await finalizePrescription(T.as("doctor"), a.value.prescriptionId);

    await T.cleanup();
    const left = await adminDb.select().from(prescriptions).where(eq(prescriptions.tenantId, T.tenantId));
    expect(left).toHaveLength(0);
  });
});

describe("repeatPrescription", () => {
  it("creates an independent draft with copied items and no Rx number", async () => {
    const { id, rxNo } = await finalized("Repeat Drug");
    const repeated = await repeatPrescription(doctor(), id);
    if (!repeated.ok) throw new Error(repeated.message);

    const copy = await getPrescription(doctor(), repeated.value.prescriptionId);
    expect(copy).toMatchObject({
      ok: true,
      value: { status: "draft", version: 1, rxNo: null, parentPrescriptionId: null, amendmentReason: null },
    });
    expect(copy.ok && copy.value.items.map((i) => i.drugName)).toEqual(["Repeat Drug"]);
    expect(copy.ok && copy.value.visit.visitType).toBe("follow-up");

    const original = await getPrescription(doctor(), id);
    expect(original).toMatchObject({ ok: true, value: { status: "finalized", rxNo } });
  });

  it("rejects drafts, unauthorized roles, and other clinics", async () => {
    const draftId = await draftWithItem();
    expect(await repeatPrescription(doctor(), draftId)).toMatchObject({ ok: false, code: "conflict" });
    const { id } = await finalized();
    expect(await repeatPrescription(A.as("reception"), id)).toMatchObject({ ok: false, code: "forbidden" });
    expect(await repeatPrescription(B.as("doctor"), id)).toMatchObject({ ok: false, code: "not_found" });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```powershell
npm run test -- tests/integration/prescriptions-lifecycle.test.ts
```

Expected: FAIL — `finalizePrescription` etc. are not exported.

- [ ] **Step 3: Implement finalize, amend, and repeat**

In `src/server/services/prescriptions.ts`, add these imports at the top (merge with the existing ones):

```ts
import { count } from "drizzle-orm";
import { z } from "zod";
import { pgErrorInfo } from "@/server/db/errors";
import { allocateNumber } from "./numbering";
```

Append to the file:

```ts
const IMMUTABLE_MESSAGE = "This prescription is finalized and cannot be changed.";
const reasonSchema = z
  .string()
  .trim()
  .min(5, "Give a reason of at least 5 characters")
  .max(500, "Keep the reason under 500 characters");

export async function finalizePrescription(
  ctx: ServiceContext,
  id: string,
): Promise<Result<{ rxNo: number; version: number }>> {
  if (!can(ctx.role, "rx.finalize")) return fail("forbidden", "Only doctors can finalize prescriptions.");
  if (!isUuid(id)) return prescriptionNotFound();

  try {
    return await withTenant(ctx.tenantId, async (tx) => {
      // The row lock serializes double-clicks: the second request waits, then sees "finalized".
      const [rx] = await tx.select().from(prescriptions).where(eq(prescriptions.id, id)).limit(1).for("update");
      if (!rx) return prescriptionNotFound();
      if (rx.status !== "draft") return fail("conflict", "This prescription is already finalized.");

      const [{ value: itemCount }] = await tx
        .select({ value: count() })
        .from(prescriptionItems)
        .where(eq(prescriptionItems.prescriptionId, id));
      if (itemCount === 0) return fail("invalid", "Add at least one medicine before finalizing.", "items");

      // Amendments keep their parent's number; first versions get the next one. Allocating
      // only after every check passes means a failed finalize never burns a number.
      const rxNo = rx.rxNo ?? (await allocateNumber(tx, ctx.tenantId, "rx"));
      const now = new Date();

      await tx
        .update(prescriptions)
        .set({ status: "finalized", rxNo, finalizedAt: now, finalizedBy: ctx.userId })
        .where(eq(prescriptions.id, id));
      await tx.update(visits).set({ status: "finalized", finalizedAt: now }).where(eq(visits.id, rx.visitId));
      if (rx.parentPrescriptionId) {
        await tx
          .update(prescriptions)
          .set({ status: "amended" })
          .where(eq(prescriptions.id, rx.parentPrescriptionId));
      }
      await recordAudit(tx, ctx, {
        action: rx.parentPrescriptionId ? "prescription.amended" : "prescription.finalized",
        entityType: "prescription",
        entityId: id,
        after: { rxNo, version: rx.version },
      });
      return ok({ rxNo, version: rx.version });
    });
  } catch (error) {
    if (pgErrorInfo(error).code === "23000") return fail("immutable", IMMUTABLE_MESSAGE);
    throw error;
  }
}

export async function amendPrescription(
  ctx: ServiceContext,
  input: { prescriptionId: string; reason: string },
): Promise<Result<{ prescriptionId: string; version: number }>> {
  if (!can(ctx.role, "rx.amend")) return fail("forbidden", "Only doctors can amend prescriptions.");
  if (!isUuid(input.prescriptionId)) return prescriptionNotFound();
  const reason = reasonSchema.safeParse(input.reason);
  if (!reason.success) return fail("invalid", reason.error.issues[0].message, "reason");

  try {
    return await withTenant(ctx.tenantId, async (tx) => {
      const [source] = await tx
        .select()
        .from(prescriptions)
        .where(eq(prescriptions.id, input.prescriptionId))
        .limit(1)
        .for("update");
      if (!source) return prescriptionNotFound();
      if (source.status === "draft") return fail("conflict", "A draft cannot be amended; edit it directly.");
      if (source.status !== "finalized") {
        return fail("conflict", "A newer version of this prescription already exists.");
      }

      const [open] = await tx
        .select({ id: prescriptions.id })
        .from(prescriptions)
        .where(and(eq(prescriptions.parentPrescriptionId, source.id), eq(prescriptions.status, "draft")))
        .limit(1);
      if (open) return fail("conflict", "An amendment is already in progress.");

      const [oldVisit] = await tx.select().from(visits).where(eq(visits.id, source.visitId)).limit(1);
      const [newVisit] = await tx
        .insert(visits)
        .values({
          tenantId: ctx.tenantId,
          patientId: oldVisit.patientId,
          doctorId: oldVisit.doctorId,
          branchId: oldVisit.branchId,
          status: "draft",
          visitType: oldVisit.visitType,
          chiefComplaint: oldVisit.chiefComplaint,
          vitals: oldVisit.vitals,
          diagnosis: oldVisit.diagnosis,
          advice: oldVisit.advice,
          followUpDate: oldVisit.followUpDate,
        })
        .returning({ id: visits.id });
      const [rx] = await tx
        .insert(prescriptions)
        .values({
          tenantId: ctx.tenantId,
          visitId: newVisit.id,
          rxNo: source.rxNo,
          version: source.version + 1,
          status: "draft",
          parentPrescriptionId: source.id,
          amendmentReason: reason.data,
          templateVersionId: source.templateVersionId,
        })
        .returning({ id: prescriptions.id, version: prescriptions.version });
      await copyItems(tx, ctx, source.id, rx.id);
      await recordAudit(tx, ctx, {
        action: "prescription.amendment_drafted",
        entityType: "prescription",
        entityId: rx.id,
        before: { version: source.version },
        after: { version: rx.version, reason: reason.data },
      });
      return ok({ prescriptionId: rx.id, version: rx.version });
    });
  } catch (error) {
    // The partial unique index is the backstop for a race the row lock did not catch.
    if (pgErrorInfo(error).code === "23505") return fail("conflict", "An amendment is already in progress.");
    throw error;
  }
}

export async function repeatPrescription(
  ctx: ServiceContext,
  id: string,
): Promise<Result<{ prescriptionId: string }>> {
  if (!can(ctx.role, "rx.draft")) return fail("forbidden", "Only doctors can write prescriptions.");
  if (!isUuid(id)) return prescriptionNotFound();

  return withTenant(ctx.tenantId, async (tx) => {
    const [source] = await tx.select().from(prescriptions).where(eq(prescriptions.id, id)).limit(1);
    if (!source) return prescriptionNotFound();
    if (source.status === "draft") return fail("conflict", "Finalize this draft before repeating it.");

    const [oldVisit] = await tx.select().from(visits).where(eq(visits.id, source.visitId)).limit(1);
    const [patient] = await tx
      .select({ id: patients.id })
      .from(patients)
      .where(and(eq(patients.id, oldVisit.patientId), isNull(patients.deletedAt)))
      .limit(1);
    if (!patient) return patientNotFound();

    const [newVisit] = await tx
      .insert(visits)
      .values({
        tenantId: ctx.tenantId,
        patientId: patient.id,
        doctorId: await doctorIdFor(tx, ctx.userId),
        branchId: oldVisit.branchId,
        status: "draft",
        visitType: "follow-up",
        chiefComplaint: oldVisit.chiefComplaint,
        diagnosis: oldVisit.diagnosis,
        advice: oldVisit.advice,
      })
      .returning({ id: visits.id });
    const [rx] = await tx
      .insert(prescriptions)
      .values({ tenantId: ctx.tenantId, visitId: newVisit.id, status: "draft", version: 1 })
      .returning({ id: prescriptions.id });
    await copyItems(tx, ctx, source.id, rx.id);
    await recordAudit(tx, ctx, {
      action: "prescription.drafted",
      entityType: "prescription",
      entityId: rx.id,
      after: { version: 1, repeatedFrom: source.id },
    });
    return ok({ prescriptionId: rx.id });
  });
}
```

- [ ] **Step 4: Run tests and typecheck**

```powershell
npm run test -- tests/integration/prescriptions-lifecycle.test.ts
npm run typecheck
```

Expected: PASS; typecheck exits 0. If the double-click test shows `lastNo` advanced by 2, the number is being allocated before the row lock: re-check that the `for("update")` select runs before `allocateNumber`.

- [ ] **Step 5: Run the whole suite**

```powershell
npm run test
```

Expected: every file passes (the earlier seed, RLS, clinical, signup, and auth tests still pass with the new triggers).

- [ ] **Step 6: Commit**

```powershell
git add src/server tests/integration/prescriptions-lifecycle.test.ts
git commit -m "feat: add finalize, amend, and repeat for prescriptions"
```

---

## Task 8: Prescription UI (editor, finalized view, amend, repeat)

**Files:**
- Create: `src/server/actions/prescriptions.ts`, `src/components/rx/draft-editor.tsx`, `src/app/(app)/prescriptions/[id]/page.tsx`, `tests/e2e/prescriptions.spec.ts`
- Modify: `src/app/(app)/patients/[id]/page.tsx`

**Interfaces:**
- Consumes: Task 6/7 services, `can`.
- Produces: route `/prescriptions/[id]`; `startPrescriptionAction(patientId)`, `saveDraftAction(id, prev, formData)`, `amendAction(id, prev, formData)`, `repeatAction(id)`; `type DraftFormState = { error?: string; field?: string; savedAt?: string }`.

- [ ] **Step 1: Write the failing e2e spec**

`tests/e2e/prescriptions.spec.ts`:

```ts
import { expect, test } from "@playwright/test";
import postgres from "postgres";
import { cleanupClinic, registerClinic, type Clinic } from "./helpers";

const clinics: Clinic[] = [];

test.afterAll(async () => {
  for (const c of clinics) await cleanupClinic(c.email);
});

test("write, save, finalize, amend, and repeat a prescription", async ({ page }) => {
  clinics.push(await registerClinic(page, "rx"));

  // A patient to prescribe for.
  await page.goto("/patients/new");
  await page.getByLabel("Name").fill("Ravi Sharma");
  await page.getByLabel("Phone").fill("9822012345");
  await page.getByRole("button", { name: /register patient/i }).click();
  await expect(page.getByRole("heading", { name: "Ravi Sharma" })).toBeVisible();

  // Start a draft.
  await page.getByRole("button", { name: /new prescription/i }).click();
  await expect(page).toHaveURL(/\/prescriptions\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { name: /draft prescription/i })).toBeVisible();

  // Finalizing an empty draft is refused with a message.
  await page.getByRole("button", { name: /^finalize$/i }).click();
  await expect(page.getByText(/at least one medicine/i)).toBeVisible();

  // Fill and save.
  await page.getByLabel("Chief complaint").fill("Fever for 2 days");
  await page.getByLabel("Diagnosis").fill("Viral fever");
  await page.getByLabel("Medicine name").first().fill("Paracetamol");
  await page.getByLabel("Dose").first().fill("1 tablet");
  await page.getByLabel("Timing").first().fill("TDS");
  await page.getByLabel("Days").first().fill("3");
  await page.getByRole("button", { name: /add medicine/i }).click();
  await page.getByLabel("Medicine name").nth(1).fill("Cetirizine");
  await page.getByRole("button", { name: /save draft/i }).click();
  await expect(page.getByText(/^Saved at/)).toBeVisible();

  // The draft survives a reload.
  await page.reload();
  await expect(page.getByLabel("Chief complaint")).toHaveValue("Fever for 2 days");
  await expect(page.getByLabel("Medicine name").nth(1)).toHaveValue("Cetirizine");

  // Finalize -> read-only view with an Rx number.
  await page.getByRole("button", { name: /^finalize$/i }).click();
  await expect(page.getByRole("heading", { name: /Rx #1/ })).toBeVisible();
  await expect(page.getByText("Paracetamol")).toBeVisible();
  await expect(page.getByRole("button", { name: /^finalize$/i })).toHaveCount(0);

  // Amend needs a reason.
  await page.getByRole("button", { name: /start amendment/i }).click();
  await expect(page.getByText(/at least 5 characters/i)).toBeVisible();
  await page.getByLabel("Reason for amendment").fill("Dose was wrong");
  await page.getByRole("button", { name: /start amendment/i }).click();
  await expect(page.getByRole("heading", { name: /draft amendment/i })).toBeVisible();
  await expect(page.getByText("Dose was wrong")).toBeVisible();

  await page.getByLabel("Dose").first().fill("2 tablets");
  await page.getByRole("button", { name: /^finalize$/i }).click();
  await expect(page.getByRole("heading", { name: /Rx #1 v2/ })).toBeVisible();
  await expect(page.getByText(/2 tablets/)).toBeVisible();

  // The patient page lists both versions with their statuses.
  await page.getByRole("link", { name: "Ravi Sharma" }).click();
  await expect(page.getByRole("link", { name: "Rx #1 v1" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Rx #1 v2" })).toBeVisible();
  await expect(page.getByRole("listitem").filter({ hasText: "Rx #1 v1" })).toContainText("amended");
  await expect(page.getByRole("listitem").filter({ hasText: "Rx #1 v2" })).toContainText("finalized");

  // Repeat creates a new independent draft.
  await page.getByRole("link", { name: "Rx #1 v2" }).click();
  await page.getByRole("button", { name: /repeat as new prescription/i }).click();
  await expect(page.getByRole("heading", { name: /draft prescription/i })).toBeVisible();
  await expect(page.getByLabel("Medicine name").first()).toHaveValue("Paracetamol");
});

test("a reception user cannot write prescriptions", async ({ page }) => {
  const clinic = await registerClinic(page, "rxperm");
  clinics.push(clinic);

  // Demote the signed-in owner to reception, as the Phase 0 e2e does. Roles are re-read per request.
  const url = process.env.ADMIN_DATABASE_URL ?? process.env.DIRECT_URL;
  expect(url).toBeTruthy();
  const sql = postgres(url!, { max: 1 });
  try {
    await sql`update memberships set role = 'reception'
      where user_id = (select id from users where email = ${clinic.email})`;
  } finally {
    await sql.end();
  }

  await page.goto("/patients/new");
  await page.getByLabel("Name").fill("Reception Registered");
  await page.getByRole("button", { name: /register patient/i }).click();
  await expect(page.getByRole("heading", { name: "Reception Registered" })).toBeVisible();
  await expect(page.getByRole("button", { name: /new prescription/i })).toHaveCount(0);
});
```

- [ ] **Step 2: Run to verify it fails**

```powershell
npm run test:e2e -- tests/e2e/prescriptions.spec.ts
```

Expected: FAIL (no "New prescription" button).

- [ ] **Step 3: Implement the server actions**

`src/server/actions/prescriptions.ts`:

```ts
"use server";

import { redirect } from "next/navigation";
import { requireSession } from "@/server/auth/session";
import {
  amendPrescription,
  finalizePrescription,
  repeatPrescription,
  saveDraft,
  startPrescription,
} from "@/server/services/prescriptions";

export type DraftFormState = { error?: string; field?: string; savedAt?: string };
export type AmendFormState = { error?: string };

export async function startPrescriptionAction(patientId: string): Promise<void> {
  const session = await requireSession();
  const result = await startPrescription(session, { patientId });
  if (!result.ok) redirect(`/patients/${patientId}?error=${result.code}`);
  redirect(`/prescriptions/${result.value.prescriptionId}`);
}

export async function saveDraftAction(
  id: string,
  _prev: DraftFormState,
  formData: FormData,
): Promise<DraftFormState> {
  const session = await requireSession();

  let payload: unknown;
  try {
    payload = JSON.parse(String(formData.get("payload") ?? "{}"));
  } catch {
    return { error: "Could not read the form. Reload the page and try again." };
  }

  const saved = await saveDraft(session, id, payload);
  if (!saved.ok) return { error: saved.message, field: saved.field };

  if (formData.get("intent") === "finalize") {
    const done = await finalizePrescription(session, id);
    if (!done.ok) return { error: done.message, field: done.field };
    redirect(`/prescriptions/${id}`);
  }
  return { savedAt: saved.value.savedAt.toISOString() };
}

export async function amendAction(
  id: string,
  _prev: AmendFormState,
  formData: FormData,
): Promise<AmendFormState> {
  const session = await requireSession();
  const result = await amendPrescription(session, {
    prescriptionId: id,
    reason: String(formData.get("reason") ?? ""),
  });
  if (!result.ok) return { error: result.message };
  redirect(`/prescriptions/${result.value.prescriptionId}`);
}

export async function repeatAction(id: string): Promise<void> {
  const session = await requireSession();
  const result = await repeatPrescription(session, id);
  if (!result.ok) redirect(`/prescriptions/${id}?error=${result.code}`);
  redirect(`/prescriptions/${result.value.prescriptionId}`);
}
```

- [ ] **Step 4: Implement the draft editor**

`src/components/rx/draft-editor.tsx`:

```tsx
"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { DraftFormState } from "@/server/actions/prescriptions";

export type EditorItem = {
  drugName: string;
  strength: string;
  form: string; // kept so a cloned or amended draft does not lose it, not edited here yet
  route: string; // same
  dose: string;
  timing: string;
  foodRelation: string;
  durationDays: string;
  remarks: string;
};

export type EditorInitial = {
  visitType: "new" | "follow-up";
  chiefComplaint: string;
  diagnosis: string;
  advice: string;
  followUpDate: string;
  items: EditorItem[];
};

const emptyItem = (): EditorItem => ({
  drugName: "",
  strength: "",
  form: "",
  route: "",
  dose: "",
  timing: "",
  foodRelation: "",
  durationDays: "",
  remarks: "",
});

const TIMING_OPTIONS = ["OD", "BD", "TDS", "QID", "HS", "SOS", "Stat"];

type Props = {
  action: (prev: DraftFormState, formData: FormData) => Promise<DraftFormState>;
  initial: EditorInitial;
};

export function DraftEditor({ action, initial }: Props) {
  const [state, formAction, pending] = useActionState(action, {} as DraftFormState);
  const [form, setForm] = useState<EditorInitial>({
    ...initial,
    items: initial.items.length > 0 ? initial.items : [emptyItem()],
  });

  const setField = <K extends keyof EditorInitial>(key: K, value: EditorInitial[K]) =>
    setForm((f) => ({ ...f, [key]: value }));
  const setItem = (index: number, patch: Partial<EditorItem>) =>
    setForm((f) => ({ ...f, items: f.items.map((it, i) => (i === index ? { ...it, ...patch } : it)) }));

  const payload = JSON.stringify({
    visitType: form.visitType,
    chiefComplaint: form.chiefComplaint,
    diagnosis: form.diagnosis.split(/[,\n]/).map((s) => s.trim()).filter(Boolean),
    advice: form.advice,
    followUpDate: form.followUpDate,
    items: form.items
      .filter((it) => it.drugName.trim() !== "" || Object.values(it).some((v) => v.trim() !== ""))
      .map((it) => ({
        ...it,
        durationDays: it.durationDays.trim() === "" ? null : Number(it.durationDays),
      })),
  });

  return (
    <form action={formAction} className="space-y-6">
      <input type="hidden" name="payload" value={payload} />

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2 sm:col-span-2">
          <Label htmlFor="chiefComplaint">Chief complaint</Label>
          <Input
            id="chiefComplaint"
            value={form.chiefComplaint}
            onChange={(e) => setField("chiefComplaint", e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="diagnosis">Diagnosis</Label>
          <Input
            id="diagnosis"
            placeholder="Comma separated"
            value={form.diagnosis}
            onChange={(e) => setField("diagnosis", e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="followUpDate">Follow-up date</Label>
          <Input
            id="followUpDate"
            type="date"
            value={form.followUpDate}
            onChange={(e) => setField("followUpDate", e.target.value)}
          />
        </div>
      </div>

      <section className="space-y-3">
        <h2 className="font-medium">Medicines</h2>
        <datalist id="timing-options">
          {TIMING_OPTIONS.map((t) => (
            <option key={t} value={t} />
          ))}
        </datalist>
        {form.items.map((item, index) => (
          <div key={index} className="grid gap-2 rounded-lg border p-3 sm:grid-cols-6">
            <Input
              aria-label="Medicine name"
              placeholder="Medicine"
              className="sm:col-span-2"
              value={item.drugName}
              onChange={(e) => setItem(index, { drugName: e.target.value })}
            />
            <Input
              aria-label="Strength"
              placeholder="Strength"
              value={item.strength}
              onChange={(e) => setItem(index, { strength: e.target.value })}
            />
            <Input
              aria-label="Dose"
              placeholder="Dose"
              value={item.dose}
              onChange={(e) => setItem(index, { dose: e.target.value })}
            />
            <Input
              aria-label="Timing"
              placeholder="Timing"
              list="timing-options"
              value={item.timing}
              onChange={(e) => setItem(index, { timing: e.target.value })}
            />
            <Input
              aria-label="Days"
              placeholder="Days"
              type="number"
              min={1}
              max={365}
              value={item.durationDays}
              onChange={(e) => setItem(index, { durationDays: e.target.value })}
            />
            <Input
              aria-label="Remarks"
              placeholder="Remarks (e.g. after food)"
              className="sm:col-span-5"
              value={item.remarks}
              onChange={(e) => setItem(index, { remarks: e.target.value })}
            />
            <Button
              type="button"
              variant="ghost"
              onClick={() =>
                setForm((f) => ({ ...f, items: f.items.length > 1 ? f.items.filter((_, i) => i !== index) : [emptyItem()] }))
              }
            >
              Remove
            </Button>
          </div>
        ))}
        <Button type="button" variant="outline" onClick={() => setForm((f) => ({ ...f, items: [...f.items, emptyItem()] }))}>
          Add medicine
        </Button>
      </section>

      <div className="space-y-2">
        <Label htmlFor="advice">Advice</Label>
        <Textarea id="advice" rows={3} value={form.advice} onChange={(e) => setField("advice", e.target.value)} />
      </div>

      {state.error ? (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      ) : null}
      {state.savedAt && !state.error ? (
        <p role="status" className="text-sm text-muted-foreground">
          Saved at {new Date(state.savedAt).toLocaleTimeString()}.
        </p>
      ) : null}

      <div className="flex gap-2">
        <Button type="submit" name="intent" value="save" variant="outline" disabled={pending}>
          Save draft
        </Button>
        <Button type="submit" name="intent" value="finalize" disabled={pending}>
          Finalize
        </Button>
      </div>
    </form>
  );
}
```

- [ ] **Step 5: Implement the prescription page**

`src/app/(app)/prescriptions/[id]/page.tsx`:

```tsx
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requireSession } from "@/server/auth/session";
import { can } from "@/lib/domain/permissions";
import { getPrescription, type PrescriptionView } from "@/server/services/prescriptions";
import { amendAction, repeatAction, saveDraftAction } from "@/server/actions/prescriptions";
import { DraftEditor, type EditorInitial } from "@/components/rx/draft-editor";
import { AmendForm } from "@/components/rx/amend-form";
import { Button } from "@/components/ui/button";

export const dynamic = "force-dynamic";

export default async function PrescriptionPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!can(session.role, "rx.read")) redirect("/dashboard");

  const { id } = await params;
  const result = await getPrescription(session, id);
  if (!result.ok) notFound();
  const rx = result.value;

  const isDraft = rx.status === "draft";
  const label = rx.rxNo ? `Rx #${rx.rxNo}` : "Prescription";
  const heading = isDraft
    ? rx.version > 1
      ? `Draft amendment (v${rx.version})`
      : "Draft prescription"
    : `${label}${rx.version > 1 ? ` v${rx.version}` : ""}`;

  const initial: EditorInitial = {
    visitType: rx.visit.visitType === "follow-up" ? "follow-up" : "new",
    chiefComplaint: rx.visit.chiefComplaint ?? "",
    diagnosis: rx.visit.diagnosis.join(", "),
    advice: rx.visit.advice ?? "",
    followUpDate: rx.visit.followUpDate ?? "",
    items: rx.items.map((i) => ({
      drugName: i.drugName,
      strength: i.strength ?? "",
      form: i.form ?? "",
      route: i.route ?? "",
      dose: i.dose ?? "",
      timing: i.timing ?? "",
      foodRelation: i.foodRelation ?? "",
      durationDays: i.durationDays?.toString() ?? "",
      remarks: i.remarks ?? "",
    })),
  };

  return (
    <div className="max-w-3xl space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">{heading}</h1>
        <p className="text-sm text-muted-foreground">
          <Link className="underline" href={`/patients/${rx.patient.id}`}>
            {rx.patient.name}
          </Link>
          {rx.patient.patientNo ? ` · Patient #${rx.patient.patientNo}` : ""} · {rx.status}
        </p>
        {rx.amendmentReason ? (
          <p className="text-sm">
            <span className="text-muted-foreground">Amendment reason: </span>
            {rx.amendmentReason}
          </p>
        ) : null}
      </header>

      {isDraft && can(session.role, "rx.draft") ? (
        <DraftEditor action={saveDraftAction.bind(null, rx.id)} initial={initial} />
      ) : (
        <ReadOnlyView rx={rx} />
      )}

      {!isDraft ? (
        <div className="flex flex-wrap items-start gap-6 border-t pt-4">
          {rx.status === "finalized" && can(session.role, "rx.amend") ? (
            <AmendForm action={amendAction.bind(null, rx.id)} />
          ) : null}
          {can(session.role, "rx.draft") ? (
            <form action={repeatAction.bind(null, rx.id)}>
              <Button type="submit" variant="outline">
                Repeat as new prescription
              </Button>
            </form>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ReadOnlyView({ rx }: { rx: PrescriptionView }) {
  return (
    <div className="space-y-4">
      <dl className="grid gap-2 text-sm sm:grid-cols-2">
        <Row label="Chief complaint" value={rx.visit.chiefComplaint} />
        <Row label="Diagnosis" value={rx.visit.diagnosis.join(", ")} />
        <Row label="Follow-up" value={rx.visit.followUpDate} />
        <Row label="Advice" value={rx.visit.advice} />
      </dl>
      <ol className="divide-y rounded-lg border">
        {rx.items.length === 0 ? <li className="p-3 text-sm text-muted-foreground">No medicines.</li> : null}
        {rx.items.map((i, index) => (
          <li key={index} className="p-3 text-sm">
            <span className="font-medium">{i.drugName}</span>
            {i.strength ? ` ${i.strength}` : ""}
            <span className="text-muted-foreground">
              {[i.dose, i.timing, i.durationDays ? `${i.durationDays} days` : null, i.remarks].filter(Boolean).map((s) => ` · ${s}`).join("")}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd>{value || "—"}</dd>
    </div>
  );
}
```

`src/components/rx/amend-form.tsx`:

```tsx
"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { AmendFormState } from "@/server/actions/prescriptions";

export function AmendForm({
  action,
}: {
  action: (prev: AmendFormState, formData: FormData) => Promise<AmendFormState>;
}) {
  const [state, formAction, pending] = useActionState(action, {} as AmendFormState);
  return (
    <form action={formAction} className="w-full max-w-sm space-y-2">
      <Label htmlFor="reason">Reason for amendment</Label>
      <Input id="reason" name="reason" placeholder="Why is this being changed?" />
      {state.error ? (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      ) : null}
      <Button type="submit" variant="outline" disabled={pending}>
        Start amendment
      </Button>
    </form>
  );
}
```

- [ ] **Step 6: Add "New prescription" and the prescription list to the patient page**

In `src/app/(app)/patients/[id]/page.tsx`, add imports:

```tsx
import Link from "next/link";
import { listPrescriptionsForPatient } from "@/server/services/prescriptions";
import { startPrescriptionAction } from "@/server/actions/prescriptions";
import { Button } from "@/components/ui/button";
```

After `const age = ...` add:

```tsx
  const history = can(session.role, "rx.read") ? await listPrescriptionsForPatient(session, p.id) : null;
```

Inside the `<header>`, after the allergies paragraph, add:

```tsx
        {can(session.role, "rx.draft") ? (
          <form action={startPrescriptionAction.bind(null, p.id)} className="mt-3">
            <Button type="submit">New prescription</Button>
          </form>
        ) : null}
```

Before the closing `</div>` of the page, add:

```tsx
      {history?.ok ? (
        <section className="space-y-2">
          <h2 className="font-medium">Prescriptions</h2>
          {history.value.length === 0 ? (
            <p className="text-sm text-muted-foreground">No prescriptions yet.</p>
          ) : (
            <ul className="divide-y rounded-lg border">
              {history.value.map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-3 p-3 text-sm">
                  <Link className="font-medium underline-offset-2 hover:underline" href={`/prescriptions/${r.id}`}>
                    {r.rxNo ? `Rx #${r.rxNo} v${r.version}` : "Draft"}
                  </Link>
                  <span className="text-muted-foreground">{r.chiefComplaint ?? ""}</span>
                  <span className="rounded bg-muted px-2 py-0.5 text-xs">{r.status}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}
```

- [ ] **Step 7: Run e2e, typecheck, lint**

```powershell
npm run test:e2e -- tests/e2e/prescriptions.spec.ts tests/e2e/patients.spec.ts
npm run typecheck
npm run lint
```

Expected: e2e PASS; typecheck exits 0; lint 0 errors. If the strict-mode locator `getByText("amended")` matches more than one element, scope it to the patient's prescription list (`page.getByRole("listitem").filter({ hasText: "Rx #1 v1" })`).

- [ ] **Step 8: Commit**

```powershell
git add src tests/e2e
git commit -m "feat: add prescription editor, finalized view, amend, and repeat"
```

---

## Task 9: Documentation, desktop-build check, and Gate 1A verification

**Files:**
- Modify: `docs/PROGRESS.md`, `AGENTS.md`, `scripts/build-desktop.mjs`, `docs/DECISIONS.md`

- [ ] **Step 1: Keep the desktop build working**

`scripts/build-desktop.mjs` stashes server-only routes. Add the new server-only route directories to its `SERVER_ONLY` list (they all use `requireSession()`, which needs a server):

The new routes live inside `src/app/(app)`, which is already stashed, so no change is needed. Confirm by running:

```powershell
npm run build:desktop
git status --short
```

Expected: build exits 0 with only the legacy routes; `git status` shows no stashed or modified source files.

- [ ] **Step 2: Record decisions**

Append to `docs/DECISIONS.md` (before "Open decisions"), using the existing ADR format:

- **ADR-0022 — Rx numbers are assigned at finalization, per tenant.** Drafts have no number so abandoned drafts leave no gaps in a medico-legal sequence; amendments keep the parent's number and increase `version`. Counter table `tenant_counters` with a row-locking upsert.
- **ADR-0023 — Immutability is enforced in Postgres triggers.** Finalized prescriptions, their items, and their visits reject update/delete with SQLSTATE 23000 even on the admin connection; only `finalized -> amended` status flips are allowed; tenant-level cascade deletes are allowed (trigger depth) so offboarding works.
- **ADR-0024 — Amendments copy the visit.** An amendment creates a new draft visit and prescription (parent link, reason, version + 1) so the finalized originals never change.

- [ ] **Step 3: Update `PROGRESS.md` and `AGENTS.md`**

In `docs/PROGRESS.md` add a "Phase 1A checklist" under section 4 with each item below ticked only with evidence (command output or test name), a session-log entry, and updated snapshot counts:

- [ ] Patients: register, edit, search (name/phone/number), duplicate warning, archive (`tests/integration/patients.test.ts`, `tests/e2e/patients.spec.ts`)
- [ ] Prescriptions: draft, save, finalize, amend (versioned, reasoned), repeat (`tests/integration/prescriptions-*.test.ts`, `tests/e2e/prescriptions.spec.ts`)
- [ ] Immutability enforced in the database (`tests/integration/immutability.test.ts`)
- [ ] Per-clinic sequential Rx numbers; abandoned drafts leave no gaps; double-finalize burns no number
- [ ] Audit events for patient created/updated/archived and prescription drafted/finalized/amendment drafted/amended
- [ ] Server-side permissions on every service (`tests/unit/permissions.test.ts` and the forbidden cases above)

In `AGENTS.md` §2 "Repository state", replace the stale "No tests, server code, database, or auth exists yet" sentence with the actual state (auth, RLS, patients, prescription lifecycle exist; templates, PDF, sharing, offline do not) and update "Last updated".

- [ ] **Step 4: Run the full gate**

```powershell
node scripts/verify-gate-0.mjs
```

Expected: `Gate 0 verification PASSED`, which now includes the new unit, integration, and e2e tests. Do not tick any box until you have seen this output.

- [ ] **Step 5: Commit**

```powershell
git add docs AGENTS.md scripts
git commit -m "docs: record Phase 1A decisions and progress"
```

---

## Self-review

**Spec / roadmap coverage (Phase 1, workstreams in this plan):**
- 1.1 patients — CRUD (Task 4, 5), search by name/phone/number (Task 4), duplicate detection (Task 4), timeline shell = per-patient prescription list (Task 8). CSV import and merge tool → plan 1C (stated).
- 1.2 visit + prescription — draft (Task 6), finalize, versioning/amend with reason, Rx numbering per clinic, clone/repeat (Task 7). **Draft autosave** is not in this plan: the editor has an explicit "Save draft" button. Autosave moves to plan 1B with the clinical-form rewrite (documented gap, not forgotten).
- 1.8 patient history — list only (Task 8); filters → 1C.
- 1.9 audit — events written in every mutation (Tasks 4, 6, 7); append-only for the app role is tested (Task 3). Print/share events arrive with those features (1B/1C).
- Exit criterion "finalized prescriptions are immutable; amendments create v2 with a reason and an audit event" — Tasks 2 and 7.
- Exit criteria about timing (60 s repeat, 30 s registration), PDF consistency, design partners, and CSV import are later-plan or field measurements.

**Placeholder scan:** none; every step has complete code or exact commands.

**Type consistency:** `ServiceContext`, `TenantTx`, `Result`/`fail`/`ok`/`invalidFrom`, `allocateNumber(tx, tenantId, name)`, `recordAudit(tx, ctx, event)`, `isUuid`, `can(role, action)` are defined in Tasks 1 and 3 and used with the same signatures in Tasks 4–8. `copyItems` is defined in Task 6 and used in Task 7. `PrescriptionView`/`EditorInitial` field names match between Task 6 and Task 8. `DraftFormState`/`AmendFormState` are defined in Task 8's actions file and imported by the two client components.

**Review Focus coverage:** (1) forbidden-role tests in Tasks 4, 6, 7; (2) double-click and double-amend races in Task 7; (3) search wildcard / format / Devanagari tests in Task 4; (4) cross-tenant and malformed id tests in Tasks 4, 6, 7; (5) direct-SQL immutability and tenant cascade in Tasks 2 and 7.

**Known follow-ups carried from Phase 0 (not part of this plan):** staging deploy and restore drill, pre-commit hook (needs owner approval to set `core.hooksPath`), first CI run on GitHub, 360 px visual check, MFA design note.
