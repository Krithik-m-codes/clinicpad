// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const FILES = ["docker-compose.yml", ".github/workflows/ci.yml"] as const;
const read = (path: string) => readFileSync(path, "utf8");

/** Every "<image>:<tag>" reference in a file, with or without a digest. */
export function pinsOf(text: string, image: string): string[] {
  const escaped = image.replace(/[/.]/g, (c) => "\\" + c);
  return [...text.matchAll(new RegExp(`${escaped}:[A-Za-z0-9._-]+(?:@sha256:[0-9a-f]{64})?`, "g"))].map((m) => m[0]);
}

describe("engine image pins", () => {
  it("pins Gotenberg to one tag and digest in compose, CI, and the smoke test", () => {
    const found = [...FILES.map(read), read("tests/integration/gotenberg-smoke.test.ts")].flatMap((t) => pinsOf(t, "gotenberg/gotenberg"));
    expect(found.length).toBeGreaterThanOrEqual(3);
    expect(new Set(found).size, found.join("\n")).toBe(1);
    expect(found[0]).toMatch(/^gotenberg\/gotenberg:\d+\.\d+\.\d+@sha256:[0-9a-f]{64}$/);
  });

  it("pins ClamAV to one tag and digest in compose and CI", () => {
    const found = FILES.map(read).flatMap((t) => pinsOf(t, "clamav/clamav"));
    expect(found.length).toBeGreaterThanOrEqual(2);
    expect(new Set(found).size, found.join("\n")).toBe(1);
    expect(found[0]).toBe("clamav/clamav:1.4.6@sha256:4cc4350d3fded380caf1799e76c0d1c93f3fa40af99c0cb2862ec0c9b117718a");
  });

  it("gives the ClamAV container the same hardening in compose and CI", () => {
    const compose = read("docker-compose.yml");
    const ci = read(".github/workflows/ci.yml");
    for (const text of [compose, ci]) {
      for (const cap of ["CHOWN", "SETUID", "SETGID", "DAC_OVERRIDE", "FOWNER"]) expect(text).toContain(cap);
      expect(text).toContain("no-new-privileges:true");
      expect(text).toContain("CLAMAV_NO_FRESHCLAMD");
      expect(text).toContain("2500m");
      expect(text).toContain("/var/log/clamav:uid=100,gid=101");
    }
    expect(ci).toContain("--read-only");
    expect(compose).toMatch(/read_only: true/);
  });
});
