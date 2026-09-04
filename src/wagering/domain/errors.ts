import { FailureCode } from "./enums";

export type DomainErrorOptions = {
  retryable?: boolean;
  details?: Record<string, unknown>;
  cause?: unknown;
};

export class DomainError extends Error {
  readonly code: FailureCode;
  readonly retryable: boolean;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(code: FailureCode, message: string, options?: DomainErrorOptions) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "DomainError";
    this.code = code;
    this.retryable = options?.retryable ?? false;
    if (options?.details !== undefined) {
      this.details = Object.freeze({ ...options.details });
    }
  }
}

function withDetails(details?: Record<string, unknown>): DomainErrorOptions | undefined {
  if (details === undefined) return undefined;
  return { details };
}

export class InvalidMoneyError extends DomainError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(FailureCode.INVALID_MONEY, message, withDetails(details));
    this.name = "InvalidMoneyError";
  }
}

export class CurrencyMismatchError extends DomainError {
  constructor(left: string, right: string) {
    super(FailureCode.WALLET_CURRENCY_MISMATCH, `Currency mismatch: ${left} vs ${right}`, {
      details: { left, right },
    });
    this.name = "CurrencyMismatchError";
  }
}

export class InsufficientBalanceError extends DomainError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(FailureCode.INSUFFICIENT_BALANCE, message, withDetails(details));
    this.name = "InsufficientBalanceError";
  }
}

export class InvalidTransactionStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidTransactionStateError";
  }
}

export class WalletAlreadyExistsError extends DomainError {
  constructor(playerId: string, currency: string) {
    super(
      FailureCode.WALLET_ALREADY_EXISTS,
      `Wallet already exists for player ${playerId} and currency ${currency}`,
      { details: { playerId, currency } },
    );
    this.name = "WalletAlreadyExistsError";
  }
}

export class DependencyUnavailableError extends DomainError {
  constructor(dependency: string) {
    super(FailureCode.DEPENDENCY_UNAVAILABLE, `Dependency unavailable: ${dependency}`, {
      retryable: true,
      details: { dependency },
    });
    this.name = "DependencyUnavailableError";
  }
}

/** Raised when Postgres lock_timeout / serialization failure aborts the TX. */
export class LockTimeoutError extends DomainError {
  constructor(message = "Wallet lock wait timed out") {
    super(FailureCode.LOCK_TIMEOUT, message, {
      retryable: true,
      details: { code: FailureCode.LOCK_TIMEOUT },
    });
    this.name = "LockTimeoutError";
  }
}
