import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { adminDb } from "@/server/db/admin";
import { withTenant } from "@/server/db/tenant";
import { auditEvents, prescriptionItems, prescriptions, tenantCounters, visits } from "@/server/db/schema";
import { createPatient } from "@/server/services/patients";
import { amendPrescription, discardDraft, getPrescription, repeatPrescription, startPrescription } from "@/server/services/prescriptions";
import { newId } from "@/lib/domain/ids";
import postgres from "postgres";
import { finalizeNow, saveDraftNow } from "../helpers/rx";
import { createTestTenant, type TestTenant } from "../helpers/tenant";

const connectionString = process.env.ADMIN_DATABASE_URL ?? process.env.DIRECT_URL ?? process.env.DATABASE_URL;
if (!connectionString) throw new Error("ADMIN_DATABASE_URL, DIRECT_URL, or DATABASE_URL is required");

const DRAFT_ONLY_MESSAGE = "Only a draft can be discarded. A finalized prescription is kept; amend it instead.";
const PENDING = Symbol("still pending");

async function settledWithin(promise: Promise<unknown>, ms: number): Promise<"settled" | typeof PENDING> {
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

/**
 * Locks a prescription row FOR UPDATE on its own connection and keeps the transaction open until `release` is
 * called; `finish` then runs inside that same transaction right before it commits. A safety net ends the holder
 * if the test body fails or hangs, so a bug fails a test instead of hanging the suite.
 */
async function holdRowLock(id: string, finish: (tx: postgres.TransactionSql) => Promise<unknown>) {
  const client = postgres(connectionString!, { max: 1, prepare: false });
  let release!: () => void;
  let aborted = false;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let markReady!: () => void;
  const ready = new Promise<void>((resolve) => (markReady = resolve));
  const done = client.begin(async (tx) => {
    await tx`set local idle_in_transaction_session_timeout = '30s'`;
    await tx`select id from prescriptions where id = ${id} for update`;
    markReady();
    await gate;
    if (aborted) throw new Error("holder aborted"); // rolls the transaction back
    await finish(tx);
  });
  done.catch(() => undefined); // surfaced through `commit`
  return {
    ready,
    commit: async () => {
      release();
      await done;
    },
    dispose: async () => {
      aborted = true;
      release();
      await done.catch(() => undefined);
      await client.end({ timeout: 5 });
    },
  };
}

let A: TestTenant;
let B: TestTenant;
let patientId = "";
const doctor = () => A.as("doctor");

beforeAll(async () => {
  A = await createTestTenant("disca");
  B = await createTestTenant("discb");
  const p = await createPatient(A.as("reception"), { name: "Discard Patient" });
  if (!p.ok) throw new Error(p.message);
  patientId = p.value.id;
});

afterAll(async () => {
  await A.cleanup();
  await B.cleanup();
});

async function draftWithItem(): Promise<{ id: string; visitId: string }> {
  const started = await startPrescription(doctor(), { patientId });
  if (!started.ok) throw new Error(started.message);
  const id = started.value.prescriptionId;
  const saved = await saveDraftNow(doctor(), id, { items: [{ drugName: "Paracetamol" }] });
  if (!saved.ok) throw new Error(saved.message);
  const [row] = await adminDb.select({ visitId: prescriptions.visitId }).from(prescriptions).where(eq(prescriptions.id, id));
  return { id, visitId: row.visitId };
}

async function finalized(): Promise<string> {
  const { id } = await draftWithItem();
  const done = await finalizeNow(doctor(), id);
  if (!done.ok) throw new Error(done.message);
  return id;
}

async function rowsOf(id: string, visitId: string) {
  const [rx, items, visit] = await Promise.all([
    adminDb.select().from(prescriptions).where(eq(prescriptions.id, id)),
    adminDb.select().from(prescriptionItems).where(eq(prescriptionItems.prescriptionId, id)),
    adminDb.select().from(visits).where(eq(visits.id, visitId)),
  ]);
  return { rx: rx.length, items: items.length, visit: visit.length };
}

async function rxCounter(): Promise<number> {
  const rows = await adminDb.select().from(tenantCounters).where(eq(tenantCounters.tenantId, A.tenantId));
  return rows.find((c) => c.name === "rx")?.lastNo ?? 0;
}

describe("discardDraft", () => {
  it("deletes a first-version draft with its items and visit, and audits ids and counts only", async () => {
    const { id, visitId } = await draftWithItem();
    expect(await discardDraft(doctor(), id)).toEqual({ ok: true, value: { patientId, parentPrescriptionId: null } });
    expect(await rowsOf(id, visitId)).toEqual({ rx: 0, items: 0, visit: 0 });
    expect(await getPrescription(doctor(), id)).toMatchObject({ ok: false, code: "not_found" });

    const audit = await withTenant(A.tenantId, (tx) => tx.select().from(auditEvents).where(eq(auditEvents.entityId, id)));
    const event = audit.find((e) => e.action === "prescription.draft_discarded");
    expect(event?.before).toEqual({ version: 1, itemCount: 1 });
    expect(JSON.stringify(event)).not.toContain("Paracetamol");
  });

  it("withdraws an open amendment, keeps the original, and frees the slot for a new amendment", async () => {
    const original = await finalized();
    const reason = "Wrong patient selected";
    const amended = await amendPrescription(doctor(), { prescriptionId: original, reason });
    if (!amended.ok) throw new Error(amended.message);

    expect(await discardDraft(doctor(), amended.value.prescriptionId)).toEqual({
      ok: true,
      value: { patientId, parentPrescriptionId: original },
    });
    expect(await getPrescription(doctor(), original)).toMatchObject({ ok: true, value: { status: "finalized", version: 1 } });
    // The one-open-amendment slot is free again.
    expect(await amendPrescription(doctor(), { prescriptionId: original, reason: "A real correction" })).toMatchObject({
      ok: true,
      value: { version: 2 },
    });

    const audit = await withTenant(A.tenantId, (tx) =>
      tx.select().from(auditEvents).where(eq(auditEvents.entityId, amended.value.prescriptionId)),
    );
    const event = audit.find((e) => e.action === "prescription.draft_discarded");
    expect(event?.before).toEqual({ version: 2, itemCount: 1, parentPrescriptionId: original });
    expect(JSON.stringify(event)).not.toContain(reason);
  });

  it("never deletes a finalized or amended version, its items, or its visit", async () => {
    const original = await finalized();
    const amended = await amendPrescription(doctor(), { prescriptionId: original, reason: "Correct the dose" });
    if (!amended.ok) throw new Error(amended.message);
    expect(await finalizeNow(doctor(), amended.value.prescriptionId)).toMatchObject({ ok: true });

    const visitIds = new Map<string, string>();
    for (const id of [original, amended.value.prescriptionId]) {
      const [row] = await adminDb.select({ visitId: prescriptions.visitId }).from(prescriptions).where(eq(prescriptions.id, id));
      visitIds.set(id, row.visitId);
    }
    for (const id of [original, amended.value.prescriptionId]) {
      expect(await discardDraft(doctor(), id)).toEqual({ ok: false, code: "immutable", message: DRAFT_ONLY_MESSAGE });
      expect(await rowsOf(id, visitIds.get(id)!)).toEqual({ rx: 1, items: 1, visit: 1 });
    }
    expect(await getPrescription(doctor(), original)).toMatchObject({ ok: true, value: { status: "amended" } });
    expect(await getPrescription(doctor(), amended.value.prescriptionId)).toMatchObject({
      ok: true,
      value: { status: "finalized" },
    });
  });

  it.each(["reception", "nurse", "pharmacist", "accountant"])("forbids %s", async (role) => {
    const { id, visitId } = await draftWithItem();
    expect(await discardDraft(A.as(role), id)).toMatchObject({ ok: false, code: "forbidden" });
    expect(await rowsOf(id, visitId)).toEqual({ rx: 1, items: 1, visit: 1 });
  });

  it("lets an owner discard, and the rows are really gone", async () => {
    const { id, visitId } = await draftWithItem();
    expect(await rowsOf(id, visitId)).toEqual({ rx: 1, items: 1, visit: 1 });
    expect(await discardDraft(A.as("owner"), id)).toMatchObject({ ok: true });
    expect(await rowsOf(id, visitId)).toEqual({ rx: 0, items: 0, visit: 0 });
  });

  it("refuses a corrupt state (draft prescription on a finalized visit) without claiming a prescription is kept", async () => {
    const { id, visitId } = await draftWithItem();
    // Only the status flip is allowed on a visit, and it is allowed while the prescription is still a draft.
    await adminDb.update(visits).set({ status: "finalized", finalizedAt: new Date() }).where(eq(visits.id, visitId));

    expect(await discardDraft(doctor(), id)).toEqual({
      ok: false,
      code: "immutable",
      message: "This prescription cannot be discarded.",
    });
    // The whole transaction rolled back.
    expect(await rowsOf(id, visitId)).toEqual({ rx: 1, items: 1, visit: 1 });
  });

  it("hides other clinics' drafts, and treats malformed and unknown ids as not found", async () => {
    const { id, visitId } = await draftWithItem();
    expect(await discardDraft(B.as("doctor"), id)).toMatchObject({ ok: false, code: "not_found" });
    expect(await discardDraft(doctor(), "not-a-uuid")).toMatchObject({ ok: false, code: "not_found" });
    expect(await discardDraft(doctor(), newId())).toMatchObject({ ok: false, code: "not_found" });
    expect(await rowsOf(id, visitId)).toEqual({ rx: 1, items: 1, visit: 1 });
  });

  it("races a finalize safely: exactly one wins, and no number is burned when the discard wins", async () => {
    for (let round = 0; round < 3; round += 1) {
      const { id, visitId } = await draftWithItem();
      const before = await rxCounter();
      const [discarded, done] = await Promise.all([discardDraft(doctor(), id), finalizeNow(doctor(), id)]);
      expect([discarded.ok, done.ok].filter(Boolean)).toHaveLength(1);
      if (done.ok) {
        expect(discarded).toMatchObject({ ok: false, code: "immutable" });
        expect(await getPrescription(doctor(), id)).toMatchObject({ ok: true, value: { status: "finalized" } });
      } else {
        expect(done).toMatchObject({ ok: false, code: "not_found" });
        expect(await rowsOf(id, visitId)).toEqual({ rx: 0, items: 0, visit: 0 });
        expect(await rxCounter()).toBe(before);
      }
    }
  });
});

describe("discardDraft and finalizePrescription wait for the row lock (deterministic)", () => {
  it("a discard that waits behind a finalize sees the finalized status and deletes nothing", async () => {
    const { id, visitId } = await draftWithItem();
    const holder = await holdRowLock(id, async (tx) => {
      const rxNo = 900_000 + Math.floor(Math.random() * 90_000);
      await tx`update prescriptions set status = 'finalized', rx_no = ${rxNo}, finalized_at = now() where id = ${id}`;
      await tx`update visits set status = 'finalized', finalized_at = now() where id = ${visitId}`;
    });
    try {
      await holder.ready;
      const discard = discardDraft(doctor(), id);
      expect(await settledWithin(discard, 600), "the discard must wait for the row lock").toBe(PENDING);

      await holder.commit();
      // The status check (not the trigger) answers: the message is the draft-only one, not the corrupt-state one.
      expect(await discard).toEqual({ ok: false, code: "immutable", message: DRAFT_ONLY_MESSAGE });
      expect(await rowsOf(id, visitId)).toEqual({ rx: 1, items: 1, visit: 1 });
      expect(await getPrescription(doctor(), id)).toMatchObject({ ok: true, value: { status: "finalized" } });
    } finally {
      await holder.dispose();
    }
  });

  it("a finalize that waits behind a discard finds nothing, and burns no Rx number", async () => {
    const { id, visitId } = await draftWithItem();
    const before = await rxCounter();
    const holder = await holdRowLock(id, async (tx) => {
      await tx`delete from prescriptions where id = ${id}`;
      await tx`delete from visits where id = ${visitId}`;
    });
    try {
      await holder.ready;
      const finalize = finalizeNow(doctor(), id);
      expect(await settledWithin(finalize, 600), "the finalize must wait for the row lock").toBe(PENDING);

      await holder.commit();
      expect(await finalize).toMatchObject({ ok: false, code: "not_found" });
      expect(await rowsOf(id, visitId)).toEqual({ rx: 0, items: 0, visit: 0 });
      expect(await rxCounter()).toBe(before);
    } finally {
      await holder.dispose();
    }
  });
});

describe("repeatPrescription with an open correction", () => {
  it("refuses while an amendment draft is open, and repeats again once it is withdrawn", async () => {
    const original = await finalized();
    const amended = await amendPrescription(doctor(), { prescriptionId: original, reason: "Check the dose" });
    if (!amended.ok) throw new Error(amended.message);

    const before = await adminDb.select({ id: prescriptions.id }).from(prescriptions).where(eq(prescriptions.tenantId, A.tenantId));
    expect(await repeatPrescription(doctor(), original)).toEqual({
      ok: false,
      code: "conflict",
      message: "A correction of this prescription is in progress; finish or withdraw it first.",
    });
    const after = await adminDb.select({ id: prescriptions.id }).from(prescriptions).where(eq(prescriptions.tenantId, A.tenantId));
    expect(after).toHaveLength(before.length);

    expect((await discardDraft(doctor(), amended.value.prescriptionId)).ok).toBe(true);
    const repeated = await repeatPrescription(doctor(), original);
    expect(repeated).toMatchObject({ ok: true });
    if (repeated.ok) {
      const ids = [repeated.value.prescriptionId];
      expect(await adminDb.select().from(prescriptions).where(inArray(prescriptions.id, ids))).toHaveLength(1);
    }
  });
});
