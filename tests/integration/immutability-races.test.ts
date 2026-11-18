import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { adminDb } from "@/server/db/admin";
import { withTenant } from "@/server/db/tenant";
import { pgErrorInfo } from "@/server/db/errors";
import { newId } from "@/lib/domain/ids";
import { patients, prescriptionItems, prescriptions, tenants, visits } from "@/server/db/schema";

// Two kinds of gap that the single-statement tests in immutability.test.ts cannot see:
//  1. A trigger that reads the parent's status with a plain SELECT can pass while another transaction is in the
//     middle of finalizing that parent (it has not committed, so the old status is what the SELECT sees).
//  2. A finalized prescription whose visit is still a draft: the visit must not stay freely editable.

const connectionString = process.env.ADMIN_DATABASE_URL ?? process.env.DIRECT_URL ?? process.env.DATABASE_URL;
if (!connectionString) throw new Error("ADMIN_DATABASE_URL, DIRECT_URL, or DATABASE_URL is required");

let tenantId = "";

beforeAll(async () => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const [t] = await adminDb.insert(tenants).values({ name: "Races", slug: `races-${stamp}` }).returning();
  tenantId = t.id;
});

afterAll(async () => {
  if (tenantId) await adminDb.delete(tenants).where(eq(tenants.id, tenantId));
});

async function expectCode(promise: Promise<unknown>, code: string) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error, "expected the statement to be rejected").not.toBeNull();
  expect(pgErrorInfo(error).code).toBe(code);
}

/** A patient, a draft visit, a draft prescription and one item. */
async function draftRecords() {
  const [patient] = await adminDb.insert(patients).values({ tenantId, name: "Race P" }).returning();
  const [visit] = await adminDb.insert(visits).values({ tenantId, patientId: patient.id, status: "draft" }).returning();
  const [rx] = await adminDb.insert(prescriptions).values({ tenantId, visitId: visit.id, rxNo: null, status: "draft" }).returning();
  const [item] = await adminDb
    .insert(prescriptionItems)
    .values({ tenantId, prescriptionId: rx.id, drugName: "Paracetamol", remarks: "original" })
    .returning();
  return { patient, visit, rx, item };
}
type Records = Awaited<ReturnType<typeof draftRecords>>;

/** The prescription alone is finalized; its visit is still a draft. */
async function finalizeRxOnly(rxId: string) {
  await adminDb.update(prescriptions).set({ status: "finalized", finalizedAt: new Date() }).where(eq(prescriptions.id, rxId));
}

// ---------------------------------------------------------------------------------------------------------------
// 1. Races against a concurrent finalize, on two real connections
// ---------------------------------------------------------------------------------------------------------------

type Outcome = "commit" | "rollback";
class RolledBack extends Error {}

/** Runs `work` in a transaction on `client` and keeps that transaction open until `finish` is called. */
function holdTransactionOpen(client: postgres.Sql, work: (tx: postgres.TransactionSql) => Promise<unknown>) {
  let release!: (outcome: Outcome) => void;
  const decision = new Promise<Outcome>((resolve) => (release = resolve));
  let markReady!: () => void;
  let markFailed!: (reason: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => {
    markReady = resolve;
    markFailed = reject;
  });
  const done = client
    .begin(async (tx) => {
      try {
        await work(tx);
      } catch (e) {
        markFailed(e);
        throw e;
      }
      markReady();
      if ((await decision) === "rollback") throw new RolledBack();
    })
    .then(
      () => undefined,
      (e: unknown) => {
        if (!(e instanceof RolledBack)) throw e;
      },
    );
  done.catch(() => undefined); // the failure, if any, reaches the caller through `ready` and `finish`
  return {
    ready,
    finish: async (outcome: Outcome) => {
      release(outcome);
      await done;
    },
  };
}

const PENDING = Symbol("still pending");
async function settledWithin(promise: Promise<unknown>, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof PENDING>((resolve) => {
    timer = setTimeout(() => resolve(PENDING), ms);
  });
  try {
    return await Promise.race([promise.then(() => "settled" as const, () => "settled" as const), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

type Operation = {
  name: string;
  /** The statement that connection 2 runs while connection 1 holds an unfinished finalize open. */
  run: (c: postgres.Sql, r: Records) => Promise<unknown>;
  /** True when the row is exactly as it was before the statement ran. */
  untouched: (r: Records) => Promise<boolean>;
};

const itemCount = async (rxId: string) =>
  (await adminDb.select({ id: prescriptionItems.id }).from(prescriptionItems).where(eq(prescriptionItems.prescriptionId, rxId))).length;

const operations: Operation[] = [
  {
    name: "an item UPDATE",
    run: (c, r) => c`update prescription_items set remarks = 'changed' where id = ${r.item.id}`,
    untouched: async (r) => {
      const [row] = await adminDb.select().from(prescriptionItems).where(eq(prescriptionItems.id, r.item.id));
      return row.remarks === "original";
    },
  },
  {
    name: "an item DELETE",
    run: (c, r) => c`delete from prescription_items where id = ${r.item.id}`,
    untouched: async (r) => (await itemCount(r.rx.id)) === 1,
  },
  {
    name: "an item INSERT",
    run: (c, r) =>
      c`insert into prescription_items (id, tenant_id, prescription_id, drug_name) values (${newId()}, ${tenantId}, ${r.rx.id}, 'Sneaky')`,
    untouched: async (r) => (await itemCount(r.rx.id)) === 1,
  },
  {
    name: "a visit UPDATE",
    run: (c, r) => c`update visits set advice = 'changed' where id = ${r.visit.id}`,
    untouched: async (r) => {
      const [row] = await adminDb.select().from(visits).where(eq(visits.id, r.visit.id));
      return row.advice === null;
    },
  },
];

describe.each(operations)("$name racing a finalize that has not committed yet", (operation) => {
  /**
   * Connection 1 finalizes the prescription and stays open. Connection 2 then runs the operation. It must wait for
   * connection 1 instead of reading the old (draft) status and slipping through.
   */
  async function race(outcome: Outcome) {
    const records = await draftRecords();
    const finalizer = postgres(connectionString!, { max: 1, prepare: false });
    // Safety net only: a bug must fail this test, not hang the suite.
    const writer = postgres(connectionString!, { max: 1, prepare: false, connection: { lock_timeout: 15_000 } });
    let hold: ReturnType<typeof holdTransactionOpen> | undefined;
    let finished = false;
    try {
      hold = holdTransactionOpen(finalizer, (tx) =>
        tx`update prescriptions set status = 'finalized', finalized_at = now(), updated_at = now() where id = ${records.rx.id}`,
      );
      await hold.ready;
      // Open the writer's connection first: the lazy handshake would otherwise count towards the 500 ms
      // window below and could make a statement that is not blocked look "pending".
      await writer`select 1`;

      const statement = operation.run(writer, records).then(
        () => null,
        (e: unknown) => e,
      );
      const early = await settledWithin(statement, 500);
      expect(early, "the statement must wait for the unfinished finalize instead of passing").toBe(PENDING);

      finished = true;
      await hold.finish(outcome);
      const error = await statement;
      return { records, error };
    } finally {
      // A failed assertion must not leave the finalizing transaction open.
      if (hold && !finished) await hold.finish("rollback").catch(() => undefined);
      await Promise.allSettled([finalizer.end({ timeout: 5 }), writer.end({ timeout: 5 })]);
    }
  }

  it("is rejected with 23000 once the finalize commits, and changes nothing", async () => {
    const { records, error } = await race("commit");
    expect(error, "expected the statement to be rejected").not.toBeNull();
    expect(pgErrorInfo(error).code).toBe("23000");
    expect(await operation.untouched(records)).toBe(true);
    const [rx] = await adminDb.select().from(prescriptions).where(eq(prescriptions.id, records.rx.id));
    expect(rx.status).toBe("finalized");
  });

  it("goes through once the finalize rolls back", async () => {
    const { records, error } = await race("rollback");
    expect(error).toBeNull();
    expect(await operation.untouched(records)).toBe(false);
    const [rx] = await adminDb.select().from(prescriptions).where(eq(prescriptions.id, records.rx.id));
    expect(rx.status).toBe("draft");
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 2. A finalized prescription keeps its (still draft) visit frozen
// ---------------------------------------------------------------------------------------------------------------

type Connection = { label: string; run: <T>(fn: (c: Pick<typeof adminDb, "update">) => Promise<T>) => Promise<T> };
const connections: Connection[] = [
  { label: "the admin connection", run: (fn) => fn(adminDb) },
  { label: "the RLS-bound app connection (withTenant)", run: (fn) => withTenant(tenantId, fn) },
];

describe.each(connections)("a draft visit that owns a finalized prescription, through $label", (connection) => {
  /** A second patient of the same tenant, to move the visit to. */
  async function otherPatient() {
    const [p] = await adminDb.insert(patients).values({ tenantId, name: "Other P" }).returning();
    return p;
  }

  async function frozenVisit() {
    const records = await draftRecords();
    await finalizeRxOnly(records.rx.id);
    const [visit] = await adminDb.select().from(visits).where(eq(visits.id, records.visit.id));
    expect(visit.status, "the fixture needs a still-draft visit").toBe("draft");
    return { ...records, visit };
  }

  async function expectVisitUnchanged(before: typeof visits.$inferSelect) {
    const [after] = await adminDb.select().from(visits).where(eq(visits.id, before.id));
    expect(after).toEqual(before);
  }

  const edits: { name: string; set: (other: { id: string }) => Partial<typeof visits.$inferInsert> }[] = [
    { name: "patient_id (moves the prescription to another patient)", set: (other) => ({ patientId: other.id }) },
    { name: "advice", set: () => ({ advice: "x" }) },
    { name: "diagnosis", set: () => ({ diagnosis: ["Fever"] }) },
    { name: "chief_complaint", set: () => ({ chiefComplaint: "Headache" }) },
    { name: "status together with another column", set: () => ({ status: "finalized", finalizedAt: new Date(), advice: "x" }) },
  ];

  for (const edit of edits) {
    it(`rejects a change to ${edit.name} with 23000`, async () => {
      const { visit } = await frozenVisit();
      const other = await otherPatient();
      await expectCode(
        connection.run((c) => c.update(visits).set(edit.set(other)).where(eq(visits.id, visit.id))),
        "23000",
      );
      await expectVisitUnchanged(visit);
    });
  }

  it("still allows the plain draft -> finalized flip", async () => {
    const { visit } = await frozenVisit();
    const flipped = await connection.run((c) =>
      c.update(visits).set({ status: "finalized", finalizedAt: new Date() }).where(eq(visits.id, visit.id)).returning({ id: visits.id }),
    );
    expect(flipped, "the flip must change exactly one row").toHaveLength(1);
    const [after] = await adminDb.select().from(visits).where(eq(visits.id, visit.id));
    expect(after.status).toBe("finalized");
    expect(after.finalizedAt).not.toBeNull();
  });

  it("keeps a draft visit editable while all its prescriptions are drafts", async () => {
    const { visit } = await draftRecords();
    const other = await otherPatient();
    const edited = await connection.run((c) =>
      c
        .update(visits)
        .set({ patientId: other.id, advice: "rest", diagnosis: ["Fever"], chiefComplaint: "Cough" })
        .where(eq(visits.id, visit.id))
        .returning({ id: visits.id }),
    );
    expect(edited, "the UPDATE must change exactly one row").toHaveLength(1);
    const [after] = await adminDb.select().from(visits).where(eq(visits.id, visit.id));
    expect(after.patientId).toBe(other.id);
    expect(after.advice).toBe("rest");
  });

  it("keeps a draft visit editable while it has no prescription at all", async () => {
    const [patient] = await adminDb.insert(patients).values({ tenantId, name: "No Rx P" }).returning();
    const [visit] = await adminDb.insert(visits).values({ tenantId, patientId: patient.id, status: "draft" }).returning();
    const edited = await connection.run((c) =>
      c.update(visits).set({ advice: "rest" }).where(eq(visits.id, visit.id)).returning({ id: visits.id }),
    );
    expect(edited, "the UPDATE must change exactly one row").toHaveLength(1);
  });
});
