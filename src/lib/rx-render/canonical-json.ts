/**
 * JSON with object keys sorted at every depth, so equal values always give equal text (the input of template content
 * hashes). Arrays keep their order; undefined properties are omitted; anything JSON cannot represent exactly throws.
 * Hashing contract (Plan 2A override 5): the content hash is sha256 of this text for the definition AS STORED, so
 * the stored value must be the parsed output of the schema, never the raw input.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonicalJson: non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  throw new Error(`canonicalJson: unsupported ${typeof value}`);
}
