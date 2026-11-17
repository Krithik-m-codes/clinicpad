// @vitest-environment node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isShareToken, newShareToken, shareTokenHash } from "@/server/sharing/token";
import { resolveAppUrl, shareUrl } from "@/server/sharing/config";

describe("share tokens", () => {
  it("are 32 random bytes in base64url: 43 URL-safe characters, never repeated", () => {
    const tokens = new Set(Array.from({ length: 2000 }, () => newShareToken()));
    expect(tokens.size).toBe(2000);
    for (const t of tokens) expect(isShareToken(t)).toBe(true);
  });

  it("are stored only as their SHA-256 hex digest", () => {
    const token = newShareToken();
    expect(shareTokenHash(token)).toBe(createHash("sha256").update(token, "utf8").digest("hex"));
    expect(shareTokenHash(token)).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    "",
    "short",
    "a".repeat(42),
    "a".repeat(44),
    `${"a".repeat(42)}=`,
    `${"a".repeat(42)}+`,
    `${"a".repeat(42)}/`,
    `${"a".repeat(41)}%2F`,
    ` ${"a".repeat(42)}`,
    `${"a".repeat(42)}\u0430`,
    null,
    42,
  ])("refuses %j before any lookup", (value) => {
    expect(isShareToken(value)).toBe(false);
  });
});

describe("resolveAppUrl", () => {
  it.each([
    [{ NEXT_PUBLIC_APP_URL: "https://app.clinicpad.in/" }, "https://app.clinicpad.in"],
    [{ NEXT_PUBLIC_APP_URL: "http://localhost:3000", NODE_ENV: "development" }, "http://localhost:3000"],
    [{ NODE_ENV: "development" }, "http://localhost:3000"],
    [{ NODE_ENV: "production" }, null],
    [{ NODE_ENV: "production", NEXT_PUBLIC_APP_URL: "http://app.clinicpad.in" }, null],
    [{ NEXT_PUBLIC_APP_URL: "https://app.clinicpad.in/path" }, null],
    [{ NEXT_PUBLIC_APP_URL: "javascript:alert(1)" }, null],
  ])("%j -> %j", (env, expected) => {
    expect(resolveAppUrl(env)).toBe(expected);
  });

  it("builds a share URL that carries nothing but the token", () => {
    expect(shareUrl("abc", "https://app.clinicpad.in")).toBe("https://app.clinicpad.in/s/abc");
  });
});

describe("middleware", () => {
  it("does not run (no login redirect) for /s/<token>, and still guards the app routes", () => {
    const source = readFileSync("src/middleware.ts", "utf8");
    const matcher = [...(/matcher:\s*\[([^\]]*)\]/.exec(source)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(matcher.length).toBeGreaterThan(0);
    const patterns = matcher.map((m) => new RegExp(`^${m.replace(/:path\*/, ".*")}$`));
    const guarded = (path: string) => patterns.some((p) => p.test(path));
    expect(guarded(`/s/${"a".repeat(43)}`)).toBe(false);
    expect(guarded("/patients/123")).toBe(true);
    expect(guarded("/prescriptions/1")).toBe(true);
  });
});
