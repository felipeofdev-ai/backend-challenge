import { describe, expect, test } from "bun:test";
import { canonicalPayloadHash } from "../../src/shared/canonical-hash";
import { InvalidMoneyError } from "../../src/wagering/domain/errors";
import { Money } from "../../src/wagering/domain/value-objects/money";

describe("forensic · Money edge cases", () => {
  test("rejects >2 decimal places (no silent round)", () => {
    expect(() => Money.from({ amount: "1.001", currency: "BRL" })).toThrow(InvalidMoneyError);
    expect(() => Money.from({ amount: "1.999", currency: "BRL" })).toThrow(InvalidMoneyError);
  });

  test("rejects scientific notation and commas", () => {
    expect(() => Money.from({ amount: "1e2", currency: "BRL" })).toThrow(InvalidMoneyError);
    expect(() => Money.from({ amount: "1,00", currency: "BRL" })).toThrow(InvalidMoneyError);
  });

  test("rejects negative input at boundary", () => {
    expect(() => Money.from({ amount: "-0.01", currency: "BRL" })).toThrow(InvalidMoneyError);
  });

  test("long chain of cents has no float drift", () => {
    let total = Money.zero("BRL");
    for (let i = 0; i < 10_000; i++) {
      total = total.add(Money.from({ amount: "0.01", currency: "BRL" }));
    }
    expect(total.toString()).toBe("100.00");
  });

  test("subtract to exact zero", () => {
    const a = Money.from({ amount: "99.99", currency: "BRL" });
    const b = Money.from({ amount: "99.99", currency: "BRL" });
    expect(a.subtract(b).isZero()).toBe(true);
  });
});

describe("forensic · payloadHash contract", () => {
  const base = {
    providerId: "p",
    externalTransactionId: "e1",
    walletId: "w1",
    playerId: "pl1",
    roundId: "r1",
    gameId: "g1",
    kind: "BET",
    money: { amount: "10.00", currency: "BRL" },
  };

  test("stable across key insertion order of money object", () => {
    const h1 = canonicalPayloadHash(base);
    const h2 = canonicalPayloadHash({
      ...base,
      money: { currency: "BRL", amount: "10.00" },
    });
    expect(h1).toBe(h2);
  });

  test("reference field is part of the business hash when present", () => {
    const without = canonicalPayloadHash(base);
    const withRef = canonicalPayloadHash({
      ...base,
      referenceExternalTransactionId: "ref-1",
    });
    expect(without).not.toBe(withRef);
  });

  test("amount 10 vs 10.00 normalize to same hash", () => {
    const a = canonicalPayloadHash({
      ...base,
      money: { amount: "10", currency: "BRL" },
    });
    const b = canonicalPayloadHash({
      ...base,
      money: { amount: "10.00", currency: "BRL" },
    });
    expect(a).toBe(b);
  });
});
