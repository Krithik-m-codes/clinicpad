import { describe, expect, it } from "vitest";
import { getTableColumns } from "drizzle-orm";
import { prescriptionItems, prescriptions, visits } from "@/server/db/schema";
import {
  AMEND_PRESCRIPTION_COLUMNS,
  AMEND_VISIT_COLUMNS,
  COPIED_ITEM_COLUMNS,
  REPEAT_PRESCRIPTION_COLUMNS,
  REPEAT_VISIT_COLUMNS,
  amendVisitValues,
  copiedColumns,
  repeatVisitValues,
  type VisitRow,
} from "@/server/services/rx-mapping";

const sorted = (values: string[]) => [...values].sort();
const keysWith = (rules: Record<string, string>, rule: string) => Object.keys(rules).filter((k) => rules[k] === rule);

describe("row-copy column rules", () => {
  it.each([
    ["visits amend", visits, AMEND_VISIT_COLUMNS],
    ["visits repeat", visits, REPEAT_VISIT_COLUMNS],
    ["prescription_items", prescriptionItems, COPIED_ITEM_COLUMNS],
    ["prescriptions amend", prescriptions, AMEND_PRESCRIPTION_COLUMNS],
    ["prescriptions repeat", prescriptions, REPEAT_PRESCRIPTION_COLUMNS],
  ])("classifies exactly the columns of %s", (_name, table, rules) => {
    expect(sorted(Object.keys(rules))).toEqual(sorted(Object.keys(getTableColumns(table))));
  });

  it("never copies the frozen snapshot, the finalize fields, or the draft counter into a new prescription", () => {
    for (const rules of [AMEND_PRESCRIPTION_COLUMNS, REPEAT_PRESCRIPTION_COLUMNS]) {
      for (const column of ["renderSnapshot", "finalizedAt", "finalizedBy", "draftRevision", "status", "pdfUrl"] as const) {
        expect(rules[column], column).toBe("reset");
      }
    }
    expect(keysWith(AMEND_PRESCRIPTION_COLUMNS, "copy")).toEqual(["rxNo"]);
    expect(keysWith(REPEAT_PRESCRIPTION_COLUMNS, "copy")).toEqual([]);
  });

  it("copies only the columns marked copy", () => {
    const row = { a: 1, b: 2, c: 3 };
    expect(copiedColumns(row, { a: "copy", b: "reset", c: "copy" } as const)).toEqual({ a: 1, c: 3 });
  });

  const visit: VisitRow = {
    id: "v1",
    tenantId: "t1",
    patientId: "p1",
    doctorId: "d1",
    branchId: "b1",
    status: "finalized",
    visitType: "new",
    chiefComplaint: "c",
    vitals: { pulse: 80 },
    diagnosis: ["d"],
    advice: "a",
    followUpDate: "2026-12-01",
    complaints: ["x"],
    medicalHistory: ["m"],
    drugHistory: ["h"],
    examinationNotes: "e",
    investigations: [{ name: "CBC" }],
    followUpReason: "r",
    finalizedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  it("builds an amendment visit from the copy columns plus a draft status", () => {
    const values = amendVisitValues(visit);
    expect(sorted(Object.keys(values))).toEqual(sorted([...keysWith(AMEND_VISIT_COLUMNS, "copy"), "status"]));
    expect(values).toMatchObject({ status: "draft", doctorId: "d1", vitals: { pulse: 80 }, examinationNotes: "e" });
  });

  it("builds a repeat visit from the copy columns plus what the caller assigns", () => {
    const values = repeatVisitValues(visit, "d2");
    expect(sorted(Object.keys(values))).toEqual(sorted([...keysWith(REPEAT_VISIT_COLUMNS, "copy"), "doctorId", "status", "visitType"]));
    expect(values).toMatchObject({ doctorId: "d2", status: "draft", visitType: "follow-up", chiefComplaint: "c" });
    expect(values).not.toHaveProperty("vitals");
    expect(values).not.toHaveProperty("examinationNotes");
    expect(values).not.toHaveProperty("followUpDate");
  });
});
