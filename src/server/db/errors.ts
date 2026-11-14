export type PgErrorInfo = { code?: string; constraint?: string };

const MAX_DEPTH = 5;

/**
 * Extracts the SQLSTATE code and constraint name from a Postgres error.
 * Drizzle wraps driver errors in a query error and keeps the original on `.cause`,
 * so look through the chain. Common codes: 23505 unique, 23503 foreign key, 23000 integrity.
 */
export function pgErrorInfo(error: unknown): PgErrorInfo {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    if (typeof current !== "object" || current === null) return {};
    const candidate = current as {
      code?: unknown;
      constraint_name?: unknown;
      constraint?: unknown;
      cause?: unknown;
    };
    if (typeof candidate.code === "string") {
      const constraint =
        typeof candidate.constraint_name === "string"
          ? candidate.constraint_name
          : typeof candidate.constraint === "string"
            ? candidate.constraint
            : undefined;
      return constraint ? { code: candidate.code, constraint } : { code: candidate.code };
    }
    current = candidate.cause;
  }
  return {};
}
