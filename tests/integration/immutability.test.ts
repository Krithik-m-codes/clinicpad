import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { adminDb } from "@/server/db/admin";
import { db } from "@/server/db/client";
import { withTenant } from "@/server/db/tenant";
import { pgErrorInfo } from "@/server/db/errors";
import { newId } from "@/lib/domain/ids";
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

/** A visit + draft prescription with one item, in the main test tenant unless another one is given. */
async function draftRx(rxNo: number | null = 1, inTenant: string = tenantId) {
  const [patient] = await adminDb.insert(patients).values({ tenantId: inTenant, name: "Immutable P" }).returning();
  const [visit] = await adminDb
    .insert(visits)
    .values({ tenantId: inTenant, patientId: patient.id, status: "draft" })
    .returning();
  const [rx] = await adminDb
    .insert(prescriptions)
    .values({ tenantId: inTenant, visitId: visit.id, rxNo, status: "draft" })
    .returning();
  const [item] = await adminDb
    .insert(prescriptionItems)
    .values({ tenantId: inTenant, prescriptionId: rx.id, drugName: "Paracetamol" })
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
  // Deleting the tenant must still work while it owns finalized and amended records. Each cleanup runs on its own,
  // so a failure of the first cannot leak the second tenant; the first failure is rethrown afterwards.
  const results = await Promise.allSettled([
    adminDb.delete(tenants).where(eq(tenants.id, tenantId)),
    adminDb.delete(tenants).where(eq(tenants.id, otherTenantId)),
  ]);
  const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failed) throw failed.reason;
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

describe("items cannot be re-parented across the draft/finalized boundary", () => {
  it("rejects moving an item of a draft prescription into a finalized one", async () => {
    const target = await draftRx(201);
    await finalize(target.rx.id, target.visit.id);
    const donor = await draftRx(null);

    // On UPDATE both parents count: the one the item leaves and the one it joins.
    await expectCode(
      adminDb.update(prescriptionItems).set({ prescriptionId: target.rx.id }).where(eq(prescriptionItems.id, donor.item.id)),
      "23000",
    );

    const targetItems = await adminDb.select().from(prescriptionItems).where(eq(prescriptionItems.prescriptionId, target.rx.id));
    expect(targetItems.map((i) => i.id)).toEqual([target.item.id]);
    const [donorItem] = await adminDb.select().from(prescriptionItems).where(eq(prescriptionItems.id, donor.item.id));
    expect(donorItem.prescriptionId).toBe(donor.rx.id);
  });

  it("rejects moving an item out of a finalized prescription", async () => {
    const source = await draftRx(204);
    await finalize(source.rx.id, source.visit.id);
    const draft = await draftRx(null);

    await expectCode(
      adminDb.update(prescriptionItems).set({ prescriptionId: draft.rx.id }).where(eq(prescriptionItems.id, source.item.id)),
      "23000",
    );
    const [kept] = await adminDb.select().from(prescriptionItems).where(eq(prescriptionItems.id, source.item.id));
    expect(kept.prescriptionId).toBe(source.rx.id);
  });

  it("still allows moving an item between two draft prescriptions", async () => {
    const from = await draftRx(null);
    const to = await draftRx(null);
    await adminDb.update(prescriptionItems).set({ prescriptionId: to.rx.id }).where(eq(prescriptionItems.id, from.item.id));
    const [moved] = await adminDb.select().from(prescriptionItems).where(eq(prescriptionItems.id, from.item.id));
    expect(moved.prescriptionId).toBe(to.rx.id);
  });
});

describe("a cascade from a non-tenant parent cannot delete finalized records", () => {
  it("rejects deleting a still-draft visit whose prescription is already finalized", async () => {
    const { rx, visit, item } = await draftRx(202);
    // finalize() flips the prescription and then the visit in two statements; stop in the window between them.
    await adminDb.update(prescriptions).set({ status: "finalized", finalizedAt: new Date() }).where(eq(prescriptions.id, rx.id));

    await expectCode(adminDb.delete(visits).where(eq(visits.id, visit.id)), "23000");

    // The whole statement rolled back: nothing under the visit disappeared.
    const [keptRx] = await adminDb.select().from(prescriptions).where(eq(prescriptions.id, rx.id));
    expect(keptRx.status).toBe("finalized");
    expect(await adminDb.select().from(visits).where(eq(visits.id, visit.id))).toHaveLength(1);
    expect(await adminDb.select().from(prescriptionItems).where(eq(prescriptionItems.id, item.id))).toHaveLength(1);
  });

  it("still lets a draft visit take its draft prescription and items with it", async () => {
    const { rx, visit } = await draftRx(null);
    await adminDb.delete(visits).where(eq(visits.id, visit.id));
    expect(await adminDb.select().from(prescriptions).where(eq(prescriptions.id, rx.id))).toHaveLength(0);
    expect(await adminDb.select().from(prescriptionItems).where(eq(prescriptionItems.prescriptionId, rx.id))).toHaveLength(0);
  });
});

describe("the RLS-bound app connection (clinicpad_app) is held to the same rules", () => {
  it("rejects a direct DELETE and a content UPDATE of a finalized prescription with 23000", async () => {
    const { rx, visit } = await draftRx(203);
    await finalize(rx.id, visit.id);

    // 23000 here, not 42501: the DELETE path calls tenant_is_erased(), so the app role needs EXECUTE on it.
    await expectCode(withTenant(tenantId, (tx) => tx.delete(prescriptions).where(eq(prescriptions.id, rx.id))), "23000");
    await expectCode(
      withTenant(tenantId, (tx) => tx.update(prescriptions).set({ rxNo: 999 }).where(eq(prescriptions.id, rx.id))),
      "23000",
    );

    const [unchanged] = await adminDb.select().from(prescriptions).where(eq(prescriptions.id, rx.id));
    expect(unchanged.status).toBe("finalized");
    expect(unchanged.rxNo).toBe(203);
  });

  it("still lets the app role edit and delete its own draft prescription", async () => {
    const { rx, item } = await draftRx(null);
    const updated = await withTenant(tenantId, (tx) =>
      tx.update(prescriptionItems).set({ dose: "1" }).where(eq(prescriptionItems.id, item.id)).returning({ id: prescriptionItems.id }),
    );
    expect(updated, "the UPDATE must change exactly one row").toHaveLength(1);
    const deleted = await withTenant(tenantId, (tx) =>
      tx.delete(prescriptions).where(eq(prescriptions.id, rx.id)).returning({ id: prescriptions.id }),
    );
    expect(deleted, "the DELETE must remove exactly one row").toHaveLength(1);
    expect(await adminDb.select().from(prescriptions).where(eq(prescriptions.id, rx.id))).toHaveLength(0);
  });
});

describe("tenant offboarding", () => {
  it("removes a tenant that owns finalized and amended records, an amendment chain included", async () => {
    const [off] = await adminDb
      .insert(tenants)
      .values({ name: "Offboard", slug: `offboard-${Date.now()}-${Math.random().toString(36).slice(2, 6)}` })
      .returning();
    try {
      const [patient] = await adminDb.insert(patients).values({ tenantId: off.id, name: "Offboard P" }).returning();
      const record = async (version: number, parentPrescriptionId: string | null) => {
        const [visit] = await adminDb
          .insert(visits)
          .values({ tenantId: off.id, patientId: patient.id, status: "draft" })
          .returning();
        const [rx] = await adminDb
          .insert(prescriptions)
          .values({ tenantId: off.id, visitId: visit.id, rxNo: 1, version, status: "draft", parentPrescriptionId })
          .returning();
        await adminDb.insert(prescriptionItems).values({ tenantId: off.id, prescriptionId: rx.id, drugName: "Paracetamol" });
        await finalize(rx.id, visit.id);
        return rx;
      };
      const original = await record(1, null);
      await record(2, original.id);
      await adminDb.update(prescriptions).set({ status: "amended" }).where(eq(prescriptions.id, original.id));
      await adminDb.insert(tenantCounters).values({ tenantId: off.id, name: "rx", lastNo: 1 });

      // Not vacuous: there really are frozen records to remove.
      const before = await adminDb.select().from(prescriptions).where(eq(prescriptions.tenantId, off.id));
      expect(before.map((r) => r.status).sort()).toEqual(["amended", "finalized"]);

      await adminDb.delete(tenants).where(eq(tenants.id, off.id));

      const remaining = await Promise.all([
        adminDb.select().from(patients).where(eq(patients.tenantId, off.id)),
        adminDb.select().from(visits).where(eq(visits.tenantId, off.id)),
        adminDb.select().from(prescriptions).where(eq(prescriptions.tenantId, off.id)),
        adminDb.select().from(prescriptionItems).where(eq(prescriptionItems.tenantId, off.id)),
        adminDb.select().from(tenantCounters).where(eq(tenantCounters.tenantId, off.id)),
      ]);
      expect(remaining.map((rows) => rows.length)).toEqual([0, 0, 0, 0, 0]);
    } finally {
      // Keep the original failure visible if the delete above was what failed.
      await adminDb.delete(tenants).where(eq(tenants.id, off.id)).catch(() => undefined);
    }
  });
});

describe("items fail closed on an invisible or foreign parent", () => {
  /** Tenant B's prescription with one item (finalized or not), and tenant A's draft prescription with one item. */
  async function crossTenantFixture(foreignFinalized: boolean) {
    const foreign = await draftRx(null, otherTenantId);
    if (foreignFinalized) await finalize(foreign.rx.id, foreign.visit.id);
    const own = await draftRx(null);
    return { foreign, own };
  }
  type CrossTenantFixture = Awaited<ReturnType<typeof crossTenantFixture>>;

  async function expectUntouched({ foreign, own }: CrossTenantFixture) {
    const foreignItems = await adminDb
      .select()
      .from(prescriptionItems)
      .where(eq(prescriptionItems.prescriptionId, foreign.rx.id));
    expect(foreignItems.map((i) => i.id)).toEqual([foreign.item.id]);
    const [ownItem] = await adminDb.select().from(prescriptionItems).where(eq(prescriptionItems.id, own.item.id));
    expect(ownItem.prescriptionId).toBe(own.rx.id);
  }

  for (const foreignFinalized of [true, false]) {
    const kind = foreignFinalized ? "finalized" : "draft";

    it(`the app role cannot attach an item to another tenant's ${kind} prescription (23503)`, async () => {
      const fx = await crossTenantFixture(foreignFinalized);
      // The foreign prescription is invisible under RLS: that must read as "not found", never as "fine".
      await expectCode(
        withTenant(tenantId, (tx) =>
          tx.insert(prescriptionItems).values({ tenantId, prescriptionId: fx.foreign.rx.id, drugName: "Intruder" }),
        ),
        "23503",
      );
      await expectCode(
        withTenant(tenantId, (tx) =>
          tx.update(prescriptionItems).set({ prescriptionId: fx.foreign.rx.id }).where(eq(prescriptionItems.id, fx.own.item.id)),
        ),
        "23503",
      );
      await expectUntouched(fx);
    });

    it(`the admin connection cannot attach an item to another tenant's ${kind} prescription (23503)`, async () => {
      const fx = await crossTenantFixture(foreignFinalized);
      // Visible here, but its tenant_id differs from the item's.
      await expectCode(
        adminDb.insert(prescriptionItems).values({ tenantId, prescriptionId: fx.foreign.rx.id, drugName: "Intruder" }),
        "23503",
      );
      await expectCode(
        adminDb.update(prescriptionItems).set({ prescriptionId: fx.foreign.rx.id }).where(eq(prescriptionItems.id, fx.own.item.id)),
        "23503",
      );
      await expectUntouched(fx);
    });
  }

  it("still lets the app role add and move items among its own tenant's draft prescriptions", async () => {
    const from = await draftRx(null);
    const to = await draftRx(null);
    await withTenant(tenantId, (tx) =>
      tx.insert(prescriptionItems).values({ tenantId, prescriptionId: from.rx.id, drugName: "Added by the app" }),
    );
    await withTenant(tenantId, (tx) =>
      tx.update(prescriptionItems).set({ prescriptionId: to.rx.id }).where(eq(prescriptionItems.id, from.item.id)),
    );
    expect(await adminDb.select().from(prescriptionItems).where(eq(prescriptionItems.prescriptionId, from.rx.id))).toHaveLength(1);
    expect(await adminDb.select().from(prescriptionItems).where(eq(prescriptionItems.prescriptionId, to.rx.id))).toHaveLength(2);
  });
});

describe("the app role cannot delete tenants", () => {
  it("fails with 42501 and leaves the tenant's finalized records alone", async () => {
    const [own] = await adminDb
      .insert(tenants)
      .values({ name: "No delete", slug: `nodelete-${Date.now()}-${Math.random().toString(36).slice(2, 6)}` })
      .returning();
    try {
      const { rx, visit } = await draftRx(1, own.id);
      await finalize(rx.id, visit.id);

      await expectCode(withTenant(own.id, (tx) => tx.delete(tenants).where(eq(tenants.id, own.id))), "42501");

      expect(await adminDb.select().from(tenants).where(eq(tenants.id, own.id))).toHaveLength(1);
      const [kept] = await adminDb.select().from(prescriptions).where(eq(prescriptions.id, rx.id));
      expect(kept.status).toBe("finalized");
    } finally {
      await adminDb.delete(tenants).where(eq(tenants.id, own.id)).catch(() => undefined);
    }
  });

  it("still lets the app role update its own tenant row", async () => {
    await withTenant(tenantId, (tx) => tx.update(tenants).set({ name: "Immut renamed" }).where(eq(tenants.id, tenantId)));
    const [row] = await adminDb.select().from(tenants).where(eq(tenants.id, tenantId));
    expect(row.name).toBe("Immut renamed");
  });
});

describe("tenant_is_erased as the app role", () => {
  // The helper reads tenants as its owner. If that owner were subject to RLS it would see no rows, so with no
  // tenant context it would call every tenant erased (or raise): this canary then fails loudly.
  it("is false for an existing tenant and true for an unknown one, with no tenant context set", async () => {
    const [existing] = await db.execute<{ erased: boolean }>(sql`select public.tenant_is_erased(${tenantId}::uuid) as erased`);
    expect(existing.erased).toBe(false);
    const [unknown] = await db.execute<{ erased: boolean }>(sql`select public.tenant_is_erased(${newId()}::uuid) as erased`);
    expect(unknown.erased).toBe(true);
  });
});
