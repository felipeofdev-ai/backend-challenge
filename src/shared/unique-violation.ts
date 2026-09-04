import { classifyPgError } from "./pg-error";

/** Detect PostgreSQL unique_violation (23505). */
export function isUniqueViolation(err: unknown): boolean {
  return classifyPgError(err) === "unique";
}
