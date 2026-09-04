import Decimal from "decimal.js";
import { CurrencyMismatchError, InvalidMoneyError } from "../errors";

export interface MoneyProps {
  amount: string;
  currency: string;
}

const ISO_4217 = /^[A-Z]{3}$/;
const DECIMAL_INPUT = /^-?\d+(\.\d{1,2})?$/;

/**
 * Immutable monetary value object.
 * Fixed scale of 2 decimal places. Never uses IEEE-754 number for arithmetic.
 *
 * ADR-001: reject >2 fractional digits (never silent round).
 */
export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {}

  static from(props: MoneyProps): Money {
    const currency = Money.assertCurrency(props.currency);
    const amount = Money.parseAmount(props.amount, { allowNegative: false });
    return new Money(amount, currency);
  }

  /** Internal arithmetic path — allows negative from negate()/subtract. */
  static fromInternal(props: MoneyProps, options?: { allowNegative?: boolean }): Money {
    const currency = Money.assertCurrency(props.currency);
    const amount = Money.parseAmount(props.amount, {
      allowNegative: options?.allowNegative ?? true,
    });
    return new Money(amount, currency);
  }

  static zero(currency: string): Money {
    return new Money(new Decimal("0.00"), Money.assertCurrency(currency));
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return new Money(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.isPositive() && !this.value.isZero();
  }

  isNegative(): boolean {
    return this.value.isNegative();
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  isLessThanOrEqual(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThanOrEqualTo(other.value);
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  toJSON(): MoneyProps {
    return { amount: this.toString(), currency: this.currency };
  }

  toString(): string {
    return this.value.toFixed(2);
  }

  /** Exact decimal string for persistence (NUMERIC). */
  toPersistence(): string {
    return this.toString();
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }

  private static assertCurrency(currency: string): string {
    if (typeof currency !== "string" || !ISO_4217.test(currency)) {
      throw new InvalidMoneyError(`Invalid ISO-4217 currency: ${String(currency)}`, {
        currency,
      });
    }
    return currency;
  }

  private static parseAmount(raw: string, options: { allowNegative: boolean }): Decimal {
    if (typeof raw !== "string" || raw.trim() === "") {
      throw new InvalidMoneyError("Amount must be a non-empty decimal string", { amount: raw });
    }

    const amount = raw.trim();

    if (/[eE]/.test(amount)) {
      throw new InvalidMoneyError("Scientific notation is not allowed", { amount });
    }
    if (amount.includes(",")) {
      throw new InvalidMoneyError("Comma decimal separator is not allowed", { amount });
    }
    if (!DECIMAL_INPUT.test(amount)) {
      // Catch Infinity / NaN / extra decimals / garbage
      if (/\.\d{3,}/.test(amount)) {
        throw new InvalidMoneyError("Amount must have at most 2 decimal places", { amount });
      }
      throw new InvalidMoneyError(`Invalid money amount: ${amount}`, { amount });
    }

    let decimal: Decimal;
    try {
      decimal = new Decimal(amount);
    } catch {
      throw new InvalidMoneyError(`Invalid money amount: ${amount}`, { amount });
    }

    if (!decimal.isFinite()) {
      throw new InvalidMoneyError("Amount must be finite", { amount });
    }
    if (!options.allowNegative && decimal.isNegative()) {
      throw new InvalidMoneyError("Negative amounts are not allowed in input contracts", {
        amount,
      });
    }

    // Amount already validated to ≤2 fractional digits — normalize scale without rounding.
    return new Decimal(decimal.toFixed(2));
  }
}
