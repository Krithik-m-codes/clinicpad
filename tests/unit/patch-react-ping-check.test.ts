// @vitest-environment node
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = join(process.cwd(), "scripts", "patch-react-ping.mjs");
const dirs: string[] = [];

/** A fake install whose react-dom bundle holds `body` inside pingSuspendedRoot. */
function fakeInstall(body: string | null): { root: string; file: string } {
  const root = mkdtempSync(join(tmpdir(), "ping-"));
  dirs.push(root);
  const cjs = join(root, "node_modules", "next", "dist", "compiled", "react-dom", "cjs");
  mkdirSync(cjs, { recursive: true });
  const file = join(cjs, "react-dom-client.development.js");
  if (body !== null) writeFileSync(file, `function pingSuspendedRoot(root, wakeable, pingedLanes) {\n${body}\n}\nfunction retryTimedOutBoundary(a) {}\n`);
  return { root, file };
}

function run(root: string, ...args: string[]) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { env: { ...process.env, PATCH_REACT_PING_ROOT: root }, encoding: "utf8" });
}

const BUGGY = "  workInProgressRoot === root ? (executionContext & RenderContext) === NoContext && prepareFreshStack(root, 0) : 0;";

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("patch-react-ping --check (the prebuild guard)", () => {
  it("patches a recognised bundle and passes, and passes again once patched", () => {
    const { root, file } = fakeInstall(BUGGY);
    const first = run(root, "--check");
    expect(first.status).toBe(0);
    expect(readFileSync(file, "utf8")).toContain("facebook/react#36134");
    expect(run(root, "--check").status).toBe(0);
  });

  it("fails loudly when the bundle is not patched and not recognised", () => {
    const { root, file } = fakeInstall("  somethingElseEntirely();");
    const result = run(root, "--check");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("not patched and not recognised");
    expect(readFileSync(file, "utf8")).not.toContain("facebook/react#36134");
  });

  it("fails when no React DOM bundle is found at all", () => {
    const { root } = fakeInstall(null);
    expect(run(root, "--check").status).toBe(1);
  });

  it("fails when next is not installed", () => {
    const root = mkdtempSync(join(tmpdir(), "ping-"));
    dirs.push(root);
    expect(run(root, "--check").status).toBe(1);
  });

  it("never fails the install: without --check an unrecognised bundle only warns", () => {
    const { root } = fakeInstall("  somethingElseEntirely();");
    const result = run(root);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("WARNING");
    expect(run(mkdtempSync(join(tmpdir(), "ping-"))).status).toBe(0);
  });
});
