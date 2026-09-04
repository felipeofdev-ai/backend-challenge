import { describe, expect, test } from "bun:test";
import { Wallet } from "../../../src/wagering/domain/entities/wallet";
import {
  CurrencyMismatchError,
  InsufficientBalanceError,
} from "../../../src/wagering/domain/errors";
import { Money } from "../../../src/wagering/domain/value-objects/money";

describe("Wallet", () => {
  const now = new Date("2026-07-29T15:00:00.000Z");

  test("open starts at version 1", () => {
    const wallet = Wallet.open({
      id: "w1",
      playerId: "p1",
      initialBalance: Money.from({ amount: "100.00", currency: "BRL" }),
      now,
    });
    expect(wallet.version).toBe(1);
    expect(wallet.balance.toString()).toBe("100.00");
    expect(wallet.currency).toBe("BRL");
  });

  test("credit and debit mutate balance and version", () => {
    const wallet = Wallet.open({
      id: "w1",
      playerId: "p1",
      initialBalance: Money.zero("BRL"),
      now,
    });
    const credit = wallet.credit(Money.from({ amount: "10.00", currency: "BRL" }), now);
    expect(credit.before.toString()).toBe("0.00");
    expect(credit.after.toString()).toBe("10.00");
    expect(wallet.version).toBe(2);

    const debit = wallet.debit(Money.from({ amount: "5.00", currency: "BRL" }), now);
    expect(debit.after.toString()).toBe("5.00");
    expect(wallet.version).toBe(3);
  });

  test("debit with insufficient balance leaves state unchanged", () => {
    const wallet = Wallet.open({
      id: "w1",
      playerId: "p1",
      initialBalance: Money.from({ amount: "10.00", currency: "BRL" }),
      now,
    });
    expect(() => wallet.debit(Money.from({ amount: "100.00", currency: "BRL" }), now)).toThrow(
      InsufficientBalanceError,
    );
    expect(wallet.balance.toString()).toBe("10.00");
    expect(wallet.version).toBe(1);
  });

  test("currency mismatch on debit/credit", () => {
    const wallet = Wallet.open({
      id: "w1",
      playerId: "p1",
      initialBalance: Money.from({ amount: "10.00", currency: "BRL" }),
      now,
    });
    expect(() => wallet.debit(Money.from({ amount: "1.00", currency: "USD" }), now)).toThrow(
      CurrencyMismatchError,
    );
  });

  test("rehydrate rebuilds state without revalidation", () => {
    const wallet = Wallet.rehydrate({
      id: "w1",
      playerId: "p1",
      currency: "BRL",
      balance: Money.from({ amount: "42.00", currency: "BRL" }),
      version: 7,
      createdAt: now,
      updatedAt: now,
    });
    expect(wallet.version).toBe(7);
    expect(wallet.balance.toString()).toBe("42.00");
  });
});
