import { customType } from "drizzle-orm/pg-core";

/**
 * Raw bytes. postgres-js returns bytea as a Buffer and normally sends a Buffer parameter as bytea. Under
 * vitest's jsdom environment a Buffer fails postgres-js's `instanceof Uint8Array` check, so it was sent as
 * text and any value with a NUL byte (every PNG) failed with 22021. Writing bytea hex text (`\x...`) works
 * in both. It relies on postgres-js `infer: false` (the default): with `infer: true` the string would be typed
 * and double-encoded. tests/integration/render-snapshot.test.ts round-trips bytes containing 0x00.
 */
export const bytea = customType<{ data: Buffer; driverData: Buffer | string }>({
  dataType() {
    return "bytea";
  },
  toDriver(value) {
    return `\\x${value.toString("hex")}`;
  },
  fromDriver(value) {
    return typeof value === "string" ? Buffer.from(value.replace(/^\\x/, ""), "hex") : value;
  },
});
