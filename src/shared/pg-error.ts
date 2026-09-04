/** Classify PostgreSQL SQLSTATE for retryable vs permanent handling. */

export type PgErrorClass = "lock_timeout" | "unavailable" | "unique" | "other";

const LOCK_OR_SERIALIZATION = new Set(["55P03", "40001", "40P01", "57014"]);
const UNAVAILABLE = new Set([
  "08000",
  "08003",
  "08006",
  "08001",
  "08004",
  "53300",
  "57P01",
  "57P03",
]);

const POOL_SATURATION_RE =
  /timeout acquiring a connection|ResourceRequest timed out|Cannot acquire a connection|pool.*timeout/i;

export function extractSqlState(err: unknown): string | undefined {
  let current: unknown = err;
  for (let depth = 0; depth < 6 && current; depth += 1) {
    if (typeof current !== "object" || current === null) break;
    const node = current as { code?: unknown; cause?: unknown; previous?: unknown };
    if (typeof node.code === "string" && /^[0-9A-Z]{5}$/i.test(node.code)) {
      return node.code.toUpperCase();
    }
    current = node.cause ?? node.previous;
  }
  return undefined;
}

/** Tarn/pg pool exhausted — treat as dependency unavailable (HTTP 503). */
export function isPoolSaturationError(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 6 && current; depth += 1) {
    if (typeof current !== "object" || current === null) break;
    const node = current as { message?: unknown; name?: unknown; cause?: unknown };
    const msg = typeof node.message === "string" ? node.message : "";
    const name = typeof node.name === "string" ? node.name : "";
    if (POOL_SATURATION_RE.test(msg) || POOL_SATURATION_RE.test(name)) return true;
    current = node.cause;
  }
  return false;
}

export function classifyPgError(err: unknown): PgErrorClass {
  if (isPoolSaturationError(err)) return "unavailable";
  const code = extractSqlState(err);
  if (!code) return "other";
  if (code === "23505") return "unique";
  if (LOCK_OR_SERIALIZATION.has(code)) return "lock_timeout";
  if (UNAVAILABLE.has(code)) return "unavailable";
  return "other";
}
