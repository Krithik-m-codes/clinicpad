import { describe, expect, it } from "vitest";
import { pgErrorInfo } from "@/server/db/errors";

describe("pgErrorInfo", () => {
  it("reads code and constraint from a plain Postgres error", () => {
    expect(pgErrorInfo({ code: "23505", constraint_name: "users_email_unique" })).toEqual({
      code: "23505",
      constraint: "users_email_unique",
    });
  });

  it("unwraps a Drizzle query error that carries the Postgres error as cause", () => {
    const wrapped = new Error("Failed query", {
      cause: { code: "23505", constraint_name: "users_phone_unique" },
    });
    expect(pgErrorInfo(wrapped)).toEqual({ code: "23505", constraint: "users_phone_unique" });
  });

  it("returns empty info for non-database errors and non-objects", () => {
    expect(pgErrorInfo(new Error("boom"))).toEqual({});
    expect(pgErrorInfo("nope")).toEqual({});
    expect(pgErrorInfo(null)).toEqual({});
  });

  it("does not loop forever on a cyclic cause chain", () => {
    const a: { cause?: unknown } = {};
    a.cause = a;
    expect(pgErrorInfo(a)).toEqual({});
  });
});
