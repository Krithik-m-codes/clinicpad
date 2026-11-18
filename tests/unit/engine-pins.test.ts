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
});
