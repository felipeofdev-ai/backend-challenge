import { describe, expect, test } from "bun:test";
import {
  classifyPgError,
  extractSqlState,
  isPoolSaturationError,
} from "../../../src/shared/pg-error";
import { isUniqueViolation } from "../../../src/shared/unique-violation";

describe("pg-error taxonomy", () => {
  test("extracts SQLSTATE from nested cause", () => {
    const leaf = Object.assign(new Error("lock"), { code: "55P03" });
    const mid = new Error("wrapped", { cause: leaf });
    expect(extractSqlState(mid)).toBe("55P03");
    expect(classifyPgError(mid)).toBe("lock_timeout");
  });

  test("classifies unique and unavailable", () => {
    expect(classifyPgError(Object.assign(new Error("u"), { code: "23505" }))).toBe("unique");
    expect(isUniqueViolation(Object.assign(new Error("u"), { code: "23505" }))).toBe(true);
    expect(classifyPgError(Object.assign(new Error("d"), { code: "08006" }))).toBe("unavailable");
    expect(classifyPgError(Object.assign(new Error("x"), { code: "42P01" }))).toBe("other");
  });

  test("pool saturation / acquire timeout → unavailable (503 path)", () => {
    expect(classifyPgError(new Error("Timeout acquiring a connection from the pool."))).toBe(
      "unavailable",
    );
    expect(isPoolSaturationError(new Error("ResourceRequest timed out"))).toBe(true);
    const nested = new Error("wrapper", {
      cause: new Error("Cannot acquire a connection before timeout"),
    });
    expect(classifyPgError(nested)).toBe("unavailable");
  });
});
