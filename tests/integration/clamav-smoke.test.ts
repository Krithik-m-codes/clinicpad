// @vitest-environment node
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { createClamdScanner } from "@/server/scanning/clamd";
import { EICAR } from "../helpers/eicar";
import { makePng } from "../helpers/images";

const run = promisify(execFile);
const host = process.env.CLAMAV_HOST ?? "127.0.0.1";
const port = Number(process.env.CLAMAV_PORT ?? 3310);
const scanner = createClamdScanner({ host, port, timeoutMs: 60_000 });
const health = await scanner.health();
// CI (or CLAMAV_REQUIRED=1) must never go green without real scanner coverage.
const required = process.env.CI === "true" || process.env.CLAMAV_REQUIRED === "1";
if (!health.up) console.warn(`SKIP clamav-smoke: clamd is not reachable at ${host}:${port} (${health.detail}). Run "docker compose up -d clamav".`);

describe.runIf(required && !health.up)("ClamAV is required here", () => {
  it(`is reachable at ${host}:${port}`, () => {
    throw new Error(`ClamAV is required (CI or CLAMAV_REQUIRED=1) but not reachable at ${host}:${port}: ${health.detail}`);
  });
});

describe.runIf(health.up)("clamd", () => {
  it("names its engine and signature database", async () => {
    const outcome = await scanner.scan(makePng(32, 32));
    expect(outcome).toMatchObject({ status: "clean", engine: expect.stringMatching(/^ClamAV \d+\.\d+\.\d+\/\d+\//) });
  });

  it("flags the EICAR test file", async () => {
    expect(await scanner.scan(EICAR)).toMatchObject({ status: "infected", signature: expect.stringMatching(/EICAR/i) });
  });

  it("keeps a larger clean image clean", async () => {
    expect(await scanner.scan(makePng(1200, 600, [200, 10, 90]))).toMatchObject({ status: "clean" });
  });

  it("runs with the isolation this repo configures (config drift)", async ({ skip }) => {
    let inspected: string | null = null;
    for (const name of ["clinicpad-clamav", "clamav"]) {
      try {
        inspected = (await run("docker", ["inspect", name, "--format", "{{json .HostConfig}}"])).stdout;
        break;
      } catch {
        inspected = null;
      }
    }
    if (inspected === null) {
      if (required) throw new Error("config drift check needs a local container named clinicpad-clamav or clamav (CLAMAV_REQUIRED or CI is set).");
      skip();
      return;
    }
    const config = JSON.parse(inspected) as {
      CapDrop: string[] | null;
      CapAdd: string[] | null;
      SecurityOpt: string[] | null;
      ReadonlyRootfs: boolean;
      Memory: number;
      Tmpfs: Record<string, string> | null;
      PortBindings: Record<string, { HostIp: string }[]>;
    };
    expect(config.CapDrop).toContain("ALL");
    // Exactly the set the S4 spike proved necessary; anything extra is drift.
    expect([...(config.CapAdd ?? [])].map((c) => c.replace(/^CAP_/, "")).sort()).toEqual(["CHOWN", "DAC_OVERRIDE", "FOWNER", "SETGID", "SETUID"]);
    expect(config.SecurityOpt).toContain("no-new-privileges:true");
    expect(config.ReadonlyRootfs).toBe(true);
    expect(config.Memory).toBe(2500 * 1024 * 1024);
    expect(Object.keys(config.Tmpfs ?? {}).sort()).toEqual(["/run", "/tmp", "/var/log/clamav"]);
    for (const bindings of Object.values(config.PortBindings ?? {})) for (const b of bindings) expect(b.HostIp).toBe("127.0.0.1");
  });
});
