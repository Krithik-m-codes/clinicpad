import type { MalwareScanner, ScanOutcome } from "@/server/scanning/scanner";

export type FakeScanner = MalwareScanner & { calls: number; sizes: number[]; next: ScanOutcome; up: boolean };

const CLEAN: ScanOutcome = { status: "clean", engine: "fake-scanner 1.0" };

export function createFakeScanner(next: ScanOutcome = CLEAN): FakeScanner {
  const scanner: FakeScanner = {
    calls: 0,
    sizes: [],
    next,
    up: true,
    async scan(bytes) {
      scanner.calls += 1;
      scanner.sizes.push(bytes.length);
      return scanner.next;
    },
    async health() {
      return scanner.up ? { up: true, detail: "fake" } : { up: false, detail: "fake down" };
    },
  };
  return scanner;
}

/** One instance for vi.mock("@/server/scanning") factories and the tests that inspect it. */
export const sharedFakeScanner = createFakeScanner();

export function resetFakeScanner(scanner: FakeScanner): void {
  scanner.calls = 0;
  scanner.sizes.length = 0;
  scanner.next = CLEAN;
  scanner.up = true;
}
