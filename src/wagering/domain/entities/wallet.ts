import { CurrencyMismatchError, InsufficientBalanceError } from "../errors";
import { Money } from "../value-objects/money";

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface BalanceChange {
  before: Money;
  after: Money;
}

/**
 * Wallet aggregate root.
 * version increments only when balance changes (ADR-008).
 */
export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: {
    id: string;
    playerId: string;
    initialBalance: Money;
    now?: Date;
  }): Wallet {
    const now = props.now ?? new Date();
    return new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      now,
      now,
    );
  }

  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  debit(money: Money, at: Date = new Date()): BalanceChange {
    this.assertSameCurrency(money);
    if (!money.isPositive()) {
      throw new InsufficientBalanceError("Debit amount must be positive", {
        amount: money.toJSON(),
      });
    }
    if (this._balance.isLessThan(money)) {
      throw new InsufficientBalanceError(
        `Insufficient balance for debit of ${money.toString()} ${money.currency} (balance ${this._balance.toString()} ${this._balance.currency})`,
        {
          balance: this._balance.toJSON(),
          attempted: money.toJSON(),
        },
      );
    }
    const before = this._balance;
    const after = before.subtract(money);
    this._balance = after;
    this._version += 1;
    this._updatedAt = at;
    return { before, after };
  }

  credit(money: Money, at: Date = new Date()): BalanceChange {
    this.assertSameCurrency(money);
    if (!money.isPositive()) {
      throw new InsufficientBalanceError("Credit amount must be positive", {
        amount: money.toJSON(),
      });
    }
    const before = this._balance;
    const after = before.add(money);
    this._balance = after;
    this._version += 1;
    this._updatedAt = at;
    return { before, after };
  }

  private assertSameCurrency(money: Money): void {
    if (this.currency !== money.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}
