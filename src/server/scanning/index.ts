import { createClamdScanner } from "./clamd";
import type { MalwareScanner } from "./scanner";

type ScannerEnv = {
  NODE_ENV?: string;
  CLAMAV_HOST?: string;
  CLAMAV_PORT?: string;
  CLAMAV_DISABLED_FOR_DEVELOPMENT?: string;
  CLAMAV_DISABLED_ACK?: string;
};

export type ScannerConfig = { ok: true; host: string; port: number } | { ok: true; disabled: true } | { ok: false; detail: string };

/** The second guard of the development bypass: it must be typed out in full, so a copied flag alone does nothing. */
export const DEV_BYPASS_ACK = "unscanned-uploads-on-this-machine";

/**
 * CLAMAV_HOST and CLAMAV_PORT: mandatory in production (like GOTENBERG_URL), the local container otherwise.
 * CLAMAV_DISABLED_FOR_DEVELOPMENT=1 skips scanning only when NODE_ENV is exactly "development" AND
 * CLAMAV_DISABLED_ACK equals DEV_BYPASS_ACK. In every other case a set flag is a configuration error, so every upload
 * is refused (fail closed).
 */
export function resolveScannerConfig(env: ScannerEnv): ScannerConfig {
  const production = env.NODE_ENV === "production";
  const bypass = (env.CLAMAV_DISABLED_FOR_DEVELOPMENT ?? "").trim();
  if (bypass !== "" && bypass !== "0") {
    const allowed = env.NODE_ENV === "development" && bypass === "1" && env.CLAMAV_DISABLED_ACK === DEV_BYPASS_ACK;
    return allowed
      ? { ok: true, disabled: true }
      : {
          ok: false,
          detail:
            "CLAMAV_DISABLED_FOR_DEVELOPMENT needs NODE_ENV=development, the value 1, and CLAMAV_DISABLED_ACK set to the acknowledgement text; it is never allowed otherwise",
        };
  }
  const host = (env.CLAMAV_HOST ?? "").trim();
  const portText = (env.CLAMAV_PORT ?? "").trim();
  if (host === "" || portText === "") {
    if (production) return { ok: false, detail: "CLAMAV_HOST and CLAMAV_PORT are not set" };
    if (host === "" && portText === "") return { ok: true, host: "127.0.0.1", port: 3310 };
  }
  const port = Number(portText || "3310");
  if (!/^\d{1,5}$/.test(portText || "3310") || port < 1 || port > 65535) return { ok: false, detail: "CLAMAV_PORT must be a port number" };
  const name = host || "127.0.0.1";
  if (!/^[A-Za-z0-9.-]{1,253}$/.test(name)) return { ok: false, detail: "CLAMAV_HOST must be a host name or an IPv4 address" };
  return { ok: true, host: name, port };
}

let warned = false;

export function scannerFor(config: ScannerConfig): MalwareScanner {
  if (!config.ok) {
    return {
      async scan() {
        return { status: "unavailable", reason: config.detail };
      },
      async health() {
        return { up: false, detail: config.detail };
      },
    };
  }
  if ("disabled" in config) {
    if (!warned) {
      warned = true;
      console.warn("[scan] CLAMAV_DISABLED_FOR_DEVELOPMENT=1: uploads are stored WITHOUT a malware scan (development only)");
    }
    return {
      async scan() {
        return { status: "clean", engine: "unscanned-development" };
      },
      async health() {
        return { up: true, detail: "disabled for development" };
      },
    };
  }
  return createClamdScanner({ host: config.host, port: config.port });
}

let scanner: MalwareScanner | null = null;

/** The process-wide scanner, configured from the environment (see resolveScannerConfig). */
export function getMalwareScanner(): MalwareScanner {
  if (scanner === null) {
    scanner = scannerFor(
      resolveScannerConfig({
        NODE_ENV: process.env.NODE_ENV,
        CLAMAV_HOST: process.env.CLAMAV_HOST,
        CLAMAV_PORT: process.env.CLAMAV_PORT,
        CLAMAV_DISABLED_FOR_DEVELOPMENT: process.env.CLAMAV_DISABLED_FOR_DEVELOPMENT,
        CLAMAV_DISABLED_ACK: process.env.CLAMAV_DISABLED_ACK,
      }),
    );
  }
  return scanner;
}
