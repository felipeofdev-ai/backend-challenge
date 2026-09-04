import {
  FailureCode,
  LedgerDirection,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../enums";
import { DomainError, InvalidTransactionStateError } from "../errors";
import { Money } from "../value-objects/money";

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt?: Date;
  /** Internal use only — OPENING credits. */
  allowOpening?: boolean;
}

export interface WagerTransactionState {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt: Date;
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
  resultBalance?: Money;
  referenceAttempts: number;
  nextReprocessAt?: Date;
  reprocessDeadline?: Date;
}

const TERMINAL: ReadonlySet<WagerTransactionStatus> = new Set([
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.Failed,
]);

/**
 * Valid transitions:
 * PENDING → PROCESSED | PENDING_REFERENCE | REJECTED | FAILED
 * PENDING_REFERENCE → PROCESSED | REJECTED | FAILED
 * Terminal states cannot transition.
 */
export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId: string | undefined,
    private _failureCode: FailureCode | undefined,
    private _processedAt: Date | undefined,
    private _resultBalance: Money | undefined,
    private _referenceAttempts: number,
    private _nextReprocessAt: Date | undefined,
    private _reprocessDeadline: Date | undefined,
  ) {}

  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind === WagerTransactionKind.Opening && !props.allowOpening) {
      throw new DomainError(
        FailureCode.KIND_NOT_ALLOWED,
        "OPENING is an internal kind and cannot be submitted via API or queue",
      );
    }

    if (!props.money.isPositive() && props.kind !== WagerTransactionKind.Opening) {
      throw new DomainError(FailureCode.INVALID_MONEY, "Wager transaction money must be positive", {
        details: { amount: props.money.toJSON() },
      });
    }

    const requiresRef =
      props.kind === WagerTransactionKind.Refund || props.kind === WagerTransactionKind.Rollback;

    if (requiresRef && !props.referenceExternalTransactionId) {
      throw new DomainError(
        FailureCode.REFERENCE_REQUIRED,
        `${props.kind} requires referenceExternalTransactionId`,
      );
    }

    if (
      props.referenceExternalTransactionId &&
      (props.kind === WagerTransactionKind.Bet ||
        props.kind === WagerTransactionKind.Loss ||
        props.kind === WagerTransactionKind.Opening)
    ) {
      throw new DomainError(
        FailureCode.REFERENCE_NOT_ALLOWED,
        `${props.kind} must not include referenceExternalTransactionId`,
      );
    }

    const now = props.createdAt ?? new Date();
    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      props.referenceExternalTransactionId,
      now,
      WagerTransactionStatus.Pending,
      undefined,
      undefined,
      undefined,
      undefined,
      0,
      undefined,
      undefined,
    );
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      state.createdAt,
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt,
      state.resultBalance,
      state.referenceAttempts,
      state.nextReprocessAt,
      state.reprocessDeadline,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  get resultBalance(): Money | undefined {
    return this._resultBalance;
  }

  get referenceAttempts(): number {
    return this._referenceAttempts;
  }

  get nextReprocessAt(): Date | undefined {
    return this._nextReprocessAt;
  }

  get reprocessDeadline(): Date | undefined {
    return this._reprocessDeadline;
  }

  isTerminal(): boolean {
    return TERMINAL.has(this._status);
  }

  /** LOSS never moves balance. REJECTED never moves balance (enforced by use case). */
  affectsBalance(): boolean {
    switch (this.kind) {
      case WagerTransactionKind.Loss:
        return false;
      case WagerTransactionKind.Bet:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
      case WagerTransactionKind.Rollback:
      case WagerTransactionKind.Opening:
        return true;
      default: {
        const _exhaustive: never = this.kind;
        return _exhaustive;
      }
    }
  }

  requiresReference(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /**
   * Ledger direction for this transaction.
   * ROLLBACK inverts the referenced transaction's effect.
   * LOSS / non-balance ops → throws (caller must check doesAffectBalance).
   */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
      case WagerTransactionKind.Opening:
        return this.kind === WagerTransactionKind.Bet
          ? LedgerDirection.Debit
          : LedgerDirection.Credit;
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback: {
        if (!reference) {
          throw new DomainError(
            FailureCode.REFERENCE_REQUIRED,
            "ROLLBACK requires a resolved reference to determine ledger direction",
          );
        }
        const refDir = reference.ledgerDirectionFor();
        return refDir === LedgerDirection.Debit ? LedgerDirection.Credit : LedgerDirection.Debit;
      }
      case WagerTransactionKind.Loss:
        throw new DomainError(FailureCode.VALIDATION_ERROR, "LOSS does not produce a ledger entry");
      default: {
        const _exhaustive: never = this.kind;
        return _exhaustive;
      }
    }
  }

  static canReference(kind: WagerTransactionKind, referenceKind: WagerTransactionKind): boolean {
    if (kind === WagerTransactionKind.Refund) {
      return referenceKind === WagerTransactionKind.Bet;
    }
    if (kind === WagerTransactionKind.Rollback) {
      return (
        referenceKind === WagerTransactionKind.Bet ||
        referenceKind === WagerTransactionKind.Win ||
        referenceKind === WagerTransactionKind.Refund
      );
    }
    if (kind === WagerTransactionKind.Win) {
      return referenceKind === WagerTransactionKind.Bet;
    }
    return false;
  }

  markProcessed(referenceTransactionId: string | undefined, at: Date, resultBalance: Money): void {
    this.assertNotTerminal("markProcessed");
    if (
      this._status !== WagerTransactionStatus.Pending &&
      this._status !== WagerTransactionStatus.PendingReference
    ) {
      throw new InvalidTransactionStateError(`Cannot markProcessed from status ${this._status}`);
    }
    if (
      (this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback) &&
      !referenceTransactionId
    ) {
      throw new InvalidTransactionStateError(
        "PROCESSED REFUND/ROLLBACK requires reference_transaction_id",
      );
    }
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = at;
    this._resultBalance = resultBalance;
    this._failureCode = undefined;
  }

  markPendingReference(now: Date, deadline: Date, nextAt: Date): void {
    this.assertNotTerminal("markPendingReference");
    if (this._status !== WagerTransactionStatus.Pending) {
      throw new InvalidTransactionStateError(
        `Cannot markPendingReference from status ${this._status}`,
      );
    }
    this._status = WagerTransactionStatus.PendingReference;
    this._referenceAttempts = 0;
    this._reprocessDeadline = deadline;
    this._nextReprocessAt = nextAt;
    void now;
  }

  scheduleReferenceRetry(now: Date, nextAt: Date): void {
    if (this._status !== WagerTransactionStatus.PendingReference) {
      throw new InvalidTransactionStateError(
        `Cannot scheduleReferenceRetry from status ${this._status}`,
      );
    }
    this._referenceAttempts += 1;
    this._nextReprocessAt = nextAt;
    void now;
  }

  reject(code: FailureCode, at: Date, resultBalance?: Money): void {
    this.assertNotTerminal("reject");
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._processedAt = at;
    if (resultBalance !== undefined) {
      this._resultBalance = resultBalance;
    }
  }

  fail(code: FailureCode, at: Date): void {
    this.assertNotTerminal("fail");
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this._processedAt = at;
  }

  private assertNotTerminal(op: string): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(
        `Cannot ${op}: transaction ${this.id} is already terminal (${this._status})`,
      );
    }
  }
}
