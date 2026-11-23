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
    const composeText = read("docker-compose.yml");
    const compose = serviceBlock(composeText, "clamav");
    const ciText = read(".github/workflows/ci.yml");
    const start = ciText.indexOf("docker run -d --name clamav");
    expect(start).toBeGreaterThan(-1);
    const ci = ciText.slice(start, ciText.indexOf("clamav/clamav:", start));
    for (const [name, text] of [["compose clamav service", compose], ["ci docker run", ci]] as const) {
      for (const cap of ["CHOWN", "SETUID", "SETGID", "DAC_OVERRIDE", "FOWNER"]) expect(text, `${name} ${cap}`).toContain(cap);
      expect(text, name).toContain("no-new-privileges:true");
      expect(text, name).toMatch(/CLAMAV_NO_FRESHCLAMD[=:]\s*"?true/);
      expect(text, name).toContain("/var/log/clamav:uid=100,gid=101");
      expect(text, name).toMatch(/cap_drop:\s+- ALL|--cap-drop ALL/);
    }
    expect(compose).toMatch(/read_only: true/);
    expect(compose).toMatch(/mem_limit: 2500m/);
    expect(compose).toMatch(/pids_limit: 256/);
    expect(compose).toMatch(/clamav\/clamav:1\.4\.6@sha256:[0-9a-f]{64}/);
    expect(ci).toContain("--read-only");
    expect(ci).toContain("--memory 2500m");
    expect(ci).toContain("--pids-limit 256");
    // The scanner must never run freshclam on its own: no freshclamd, and only the update job has egress.
    expect(compose).not.toMatch(/CLAMAV_NO_FRESHCLAMD:\s*"?false/);
    const update = serviceBlock(composeText, "clamav-update");
    expect(update).toMatch(/mem_limit:/);
    expect(update).toMatch(/pids_limit:/);
  });
});

/** The text of one top-level compose service (two-space indented key up to the next one). */
function serviceBlock(text: string, name: string): string {
  const lines = text.split(String.fromCharCode(10));
  const from = lines.findIndex((l) => l.trimEnd() === `  ${name}:`);
  expect(from, `service ${name}`).toBeGreaterThan(-1);
  let to = lines.findIndex((l, i) => i > from && /^ {2}\S[^:]*:\s*$/.test(l));
  if (to === -1) to = lines.length;
  return lines.slice(from, to).join("\n");
}
