import { LedgerDirection } from "../enums";
import { FailureCode } from "../enums";
import { DomainError, InvalidMoneyError } from "../errors";
import { Money } from "../value-objects/money";

export interface CreateLedgerEntryProps {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

export interface LedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

/**
 * Immutable ledger entry. No mutable fields, no transition methods.
 * create validates arithmetic: balanceBefore ± money === balanceAfter.
 */
export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly createdAt: Date,
  ) {}

  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    if (!props.money.isPositive()) {
      throw new InvalidMoneyError("Ledger entry money must be positive", {
        amount: props.money.toJSON(),
      });
    }
    const entry = new WalletLedgerEntry(
      props.id,
      props.walletId,
      props.transactionId,
      props.direction,
      props.money,
      props.balanceBefore,
      props.balanceAfter,
      props.createdAt,
    );
    if (!entry.isBalanced()) {
      throw new DomainError(FailureCode.VALIDATION_ERROR, "Ledger entry arithmetic is unbalanced", {
        details: {
          direction: props.direction,
          before: props.balanceBefore.toJSON(),
          money: props.money.toJSON(),
          after: props.balanceAfter.toJSON(),
        },
      });
    }
    return entry;
  }

  /** Rehydrate validates arithmetic integrity (not business transitions). ADR-009. */
  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    const entry = new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      state.createdAt,
    );
    if (!entry.isBalanced()) {
      throw new DomainError(
        FailureCode.VALIDATION_ERROR,
        `Corrupted ledger entry ${state.id}: unbalanced arithmetic`,
      );
    }
    return entry;
  }

  isBalanced(): boolean {
    if (this.direction === LedgerDirection.Debit) {
      return this.balanceBefore.subtract(this.money).equals(this.balanceAfter);
    }
    return this.balanceBefore.add(this.money).equals(this.balanceAfter);
  }
}
