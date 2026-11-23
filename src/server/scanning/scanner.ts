export type ScanOutcome =
  | { status: "clean"; engine: string }
  | { status: "infected"; engine: string; signature: string }
  | { status: "unavailable"; reason: string };

export type ScannerHealth = { up: boolean; detail: string };

/**
 * Scans bytes for malware before anything is stored (ADR-0046). Never throws: a scanner that is down, slow, or answers
 * something unexpected is "unavailable", and callers refuse the upload (fail closed). Injected so tests never need clamd.
 */
export interface MalwareScanner {
  scan(bytes: Uint8Array, opts?: { signal?: AbortSignal }): Promise<ScanOutcome>;
  health(): Promise<ScannerHealth>;
}

export const SCAN_LIMITS = {
  timeoutMs: 15_000,
  healthTimeoutMs: 2_000,
  maxBytes: 8 * 1024 * 1024,
  chunkBytes: 64 * 1024,
  maxReplyBytes: 4096,
  versionCacheMs: 10 * 60_000,
} as const;

/** Shown to the user. No file names, no signature names, no infrastructure detail. */
export const SCAN_MESSAGES = {
  infected: "The virus scanner flagged this file, so it was not saved. Export the image again from the original file, or send the pad to us.",
  unavailable: "The virus scanner is not available right now, so nothing was saved. Try again in a minute.",
} as const;
