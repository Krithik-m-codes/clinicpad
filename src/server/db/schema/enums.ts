import { pgEnum } from "drizzle-orm/pg-core";

export const tenantPlan = pgEnum("tenant_plan", ["free", "solo", "clinic", "chain"]);
export const memberRole = pgEnum("member_role", [
  "owner",
  "doctor",
  "reception",
  "nurse",
  "accountant",
  "pharmacist",
  "designer",
]);
export const memberStatus = pgEnum("member_status", ["invited", "active", "disabled"]);
