import { describe, expect, test } from "bun:test";
import { CurrencyMismatchError, InvalidMoneyError } from "../../../src/wagering/domain/errors";
import { Money } from "../../../src/wagering/domain/value-objects/money";

describe("Money", () => {
  test("parses fixed-scale amounts and normalizes", () => {
    expect(Money.from({ amount: "25.00", currency: "BRL" }).toString()).toBe("25.00");
    expect(Money.from({ amount: "25", currency: "BRL" }).toString()).toBe("25.00");
    expect(Money.from({ amount: "25.5", currency: "BRL" }).toString()).toBe("25.50");
    expect(Money.from({ amount: "0.00", currency: "BRL" }).isZero()).toBe(true);
  });

  test("rejects invalid inputs", () => {
    const invalid = [
      "1.999",
      "1,00",
      "",
      "abc",
      "NaN",
      "Infinity",
      "-Infinity",
      "1e3",
      "1E-3",
      "-1.00",
    ];
    for (const amount of invalid) {
      expect(() => Money.from({ amount, currency: "BRL" })).toThrow(InvalidMoneyError);
    }
  });

  test("rejects invalid currency", () => {
    expect(() => Money.from({ amount: "1.00", currency: "brl" })).toThrow(InvalidMoneyError);
    expect(() => Money.from({ amount: "1.00", currency: "REAL" })).toThrow(InvalidMoneyError);
  });

  test("add/subtract are exact (no float drift)", () => {
    const a = Money.from({ amount: "0.10", currency: "BRL" });
    const b = Money.from({ amount: "0.20", currency: "BRL" });
    expect(a.add(b).toString()).toBe("0.30");
    expect(b.subtract(a).toString()).toBe("0.10");
  });

  test("currency mismatch throws", () => {
    const brl = Money.from({ amount: "1.00", currency: "BRL" });
    const usd = Money.from({ amount: "1.00", currency: "USD" });
    expect(() => brl.add(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl.subtract(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl.isLessThan(usd)).toThrow(CurrencyMismatchError);
  });

  test("comparisons and negate", () => {
    const a = Money.from({ amount: "10.00", currency: "BRL" });
    const b = Money.from({ amount: "20.00", currency: "BRL" });
    expect(a.isLessThan(b)).toBe(true);
    expect(a.isPositive()).toBe(true);
    expect(a.negate().isNegative()).toBe(true);
    expect(a.equals(Money.from({ amount: "10.00", currency: "BRL" }))).toBe(true);
    expect(a.toJSON()).toEqual({ amount: "10.00", currency: "BRL" });
  });

  test("zero factory", () => {
    expect(Money.zero("BRL").toString()).toBe("0.00");
  });
});
