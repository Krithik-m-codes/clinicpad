import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Zero-width, bidi-control and invisible formatting characters hide in source as "Trojan Source" and make
// tests unreadable. Write them as \uXXXX escapes instead. Allow-list: none.
const INVISIBLE = new RegExp("[\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\uFEFF\\u061C\\u180E]", "u");
const TEXT_FILE = /\.(tsx?|mjs|cjs|js|jsx|css|json|md|sql)$/;
const SKIP_DIRS = new Set(["node_modules", ".dist", ".next", "__golden__"]);

function walk(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(path, found);
    } else if (TEXT_FILE.test(entry.name)) {
      found.push(path);
    }
  }
  return found;
}

describe("source hygiene", () => {
  it("has no raw invisible or bidi-control characters in src/ or tests/", () => {
    const offenders: string[] = [];
    for (const root of ["src", "tests"]) {
      for (const file of walk(join(process.cwd(), root))) {
        readFileSync(file, "utf8")
          .split("\n")
          .forEach((line, index) => {
            if (INVISIBLE.test(line)) offenders.push(`${file}:${index + 1}`);
          });
      }
    }
    expect(offenders).toEqual([]);
  });

  it("detects each forbidden character", () => {
    for (const code of [0x200b, 0x200f, 0x202a, 0x202e, 0x2060, 0x2064, 0xfeff, 0x061c, 0x180e]) {
      expect(INVISIBLE.test(`a${String.fromCodePoint(code)}b`), code.toString(16)).toBe(true);
    }
    expect(INVISIBLE.test("plain text")).toBe(false);
  });
});
