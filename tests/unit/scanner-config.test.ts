// @vitest-environment node
import { describe, expect, it } from "vitest";
import { DEV_BYPASS_ACK, resolveScannerConfig, scannerFor } from "@/server/scanning";

const DEV_ON = { NODE_ENV: "development", CLAMAV_DISABLED_FOR_DEVELOPMENT: "1", CLAMAV_DISABLED_ACK: DEV_BYPASS_ACK };

describe("resolveScannerConfig", () => {
  it("defaults to the local container in development", () => {
    expect(resolveScannerConfig({ NODE_ENV: "development" })).toEqual({ ok: true, host: "127.0.0.1", port: 3310 });
  });

  it("requires both host and port in production", () => {
    expect(resolveScannerConfig({ NODE_ENV: "production" }).ok).toBe(false);
    expect(resolveScannerConfig({ NODE_ENV: "production", CLAMAV_HOST: "clamav.internal" }).ok).toBe(false);
    expect(resolveScannerConfig({ NODE_ENV: "production", CLAMAV_HOST: "clamav.internal", CLAMAV_PORT: "3310" })).toEqual({
      ok: true,
      host: "clamav.internal",
      port: 3310,
    });
  });

  it("allows the bypass only with NODE_ENV=development AND the explicit second guard", () => {
    expect(resolveScannerConfig(DEV_ON)).toEqual({ ok: true, disabled: true });
  });

  it.each([
    ["production", "1", DEV_BYPASS_ACK],
    ["test", "1", DEV_BYPASS_ACK],
    [undefined, "1", DEV_BYPASS_ACK],
    ["development", "1", undefined],
    ["development", "1", "yes"],
    ["development", "true", DEV_BYPASS_ACK],
  ])("refuses the bypass for NODE_ENV=%s flag=%s ack=%s (fail closed)", (nodeEnv, flag, ack) => {
    const config = resolveScannerConfig({
      NODE_ENV: nodeEnv,
      CLAMAV_DISABLED_FOR_DEVELOPMENT: flag,
      CLAMAV_DISABLED_ACK: ack,
      CLAMAV_HOST: "h",
      CLAMAV_PORT: "3310",
    });
    expect(config.ok).toBe(false);
  });

  it.each(["0", "65536", "33 10", "abc", "-1"])("refuses the port %j", (port) => {
    expect(resolveScannerConfig({ NODE_ENV: "development", CLAMAV_HOST: "127.0.0.1", CLAMAV_PORT: port }).ok).toBe(false);
  });

  it.each(["has space", "a/b", "x".repeat(254)])("refuses the host %j", (host) => {
    expect(resolveScannerConfig({ NODE_ENV: "development", CLAMAV_HOST: host, CLAMAV_PORT: "3310" }).ok).toBe(false);
  });
});

describe("scannerFor", () => {
  it("refuses every upload when the scanner is not configured", async () => {
    const scanner = scannerFor({ ok: false, detail: "CLAMAV_HOST and CLAMAV_PORT are not set" });
    expect(await scanner.scan(Buffer.from("x"))).toEqual({ status: "unavailable", reason: "CLAMAV_HOST and CLAMAV_PORT are not set" });
    expect((await scanner.health()).up).toBe(false);
  });

  it("passes everything as 'unscanned-development' only when explicitly disabled", async () => {
    expect(await scannerFor({ ok: true, disabled: true }).scan(Buffer.from("x"))).toEqual({ status: "clean", engine: "unscanned-development" });
  });
});
