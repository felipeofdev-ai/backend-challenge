import { describe, expect, test } from "bun:test";
import { DomainExceptionFilter } from "../../../src/infrastructure/http/domain-exception.filter";
import { DependencyUnavailableError, LockTimeoutError } from "../../../src/wagering/domain/errors";

function mockHost(statusCapture: { status?: number; body?: unknown }) {
  const res = {
    status(code: number) {
      statusCapture.status = code;
      return this;
    },
    json(body: unknown) {
      statusCapture.body = body;
      return this;
    },
  };
  return {
    switchToHttp: () => ({
      getResponse: () => res,
    }),
  };
}

describe("DomainExceptionFilter · 503 taxonomy", () => {
  test("LockTimeoutError → 503 LOCK_TIMEOUT", () => {
    const out: { status?: number; body?: unknown } = {};
    new DomainExceptionFilter().catch(new LockTimeoutError(), mockHost(out) as never);
    expect(out.status).toBe(503);
    const body = out.body as { error: { code: string; retryable: boolean } };
    expect(body.error.code).toBe("LOCK_TIMEOUT");
    expect(body.error.retryable).toBe(true);
  });

  test("DependencyUnavailableError → 503", () => {
    const out: { status?: number; body?: unknown } = {};
    new DomainExceptionFilter().catch(
      new DependencyUnavailableError("postgres"),
      mockHost(out) as never,
    );
    expect(out.status).toBe(503);
  });

  test("unknown errors do not leak SQL text", () => {
    const out: { status?: number; body?: unknown } = {};
    new DomainExceptionFilter().catch(
      new Error('relation "wallets" does not exist'),
      mockHost(out) as never,
    );
    expect(out.status).toBe(500);
    const body = out.body as { error: { message: string } };
    expect(body.error.message).toBe("Internal error");
  });
});
