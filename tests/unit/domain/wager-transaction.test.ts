import { describe, expect, test } from "bun:test";
import { WagerTransaction } from "../../../src/wagering/domain/entities/wager-transaction";
import { WalletLedgerEntry } from "../../../src/wagering/domain/entities/wallet-ledger-entry";
import {
  FailureCode,
  LedgerDirection,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../../src/wagering/domain/enums";
import { DomainError, InvalidTransactionStateError } from "../../../src/wagering/domain/errors";
import { Money } from "../../../src/wagering/domain/value-objects/money";

const base = {
  id: "t1",
  providerId: "provider-a",
  externalTransactionId: "tx-1",
  idempotencyKey: "provider-a:tx-1",
  payloadHash: "abc",
  walletId: "w1",
  playerId: "p1",
  roundId: "round-1",
  gameId: "fortune-chimp",
  money: Money.from({ amount: "25.00", currency: "BRL" }),
};

describe("WagerTransaction", () => {
  test("BET affects balance, no reference, debit direction", () => {
    const tx = WagerTransaction.create({ ...base, kind: WagerTransactionKind.Bet });
    expect(tx.affectsBalance()).toBe(true);
    expect(tx.requiresReference()).toBe(false);
    expect(tx.ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(tx.status).toBe(WagerTransactionStatus.Pending);
  });

  test("LOSS does not affect balance", () => {
    const tx = WagerTransaction.create({ ...base, kind: WagerTransactionKind.Loss });
    expect(tx.affectsBalance()).toBe(false);
    expect(() => tx.ledgerDirectionFor()).toThrow(DomainError);
  });

  test("REFUND requires reference", () => {
    expect(() => WagerTransaction.create({ ...base, kind: WagerTransactionKind.Refund })).toThrow(
      DomainError,
    );
  });

  test("OPENING blocked unless allowOpening", () => {
    expect(() => WagerTransaction.create({ ...base, kind: WagerTransactionKind.Opening })).toThrow(
      DomainError,
    );

    const opening = WagerTransaction.create({
      ...base,
      kind: WagerTransactionKind.Opening,
      allowOpening: true,
    });
    expect(opening.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  });

  test("terminal transitions cannot be repeated", () => {
    const tx = WagerTransaction.create({ ...base, kind: WagerTransactionKind.Bet });
    const at = new Date();
    tx.markProcessed(undefined, at, Money.from({ amount: "75.00", currency: "BRL" }));
    expect(tx.isTerminal()).toBe(true);
    expect(() =>
      tx.markProcessed(undefined, at, Money.from({ amount: "75.00", currency: "BRL" })),
    ).toThrow(InvalidTransactionStateError);
    expect(() => tx.reject(FailureCode.INSUFFICIENT_BALANCE, at)).toThrow(
      InvalidTransactionStateError,
    );
  });

  test("PENDING_REFERENCE path", () => {
    const tx = WagerTransaction.create({
      ...base,
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: "bet-1",
    });
    const now = new Date();
    tx.markPendingReference(
      now,
      new Date(now.getTime() + 86_400_000),
      new Date(now.getTime() + 30_000),
    );
    expect(tx.status).toBe(WagerTransactionStatus.PendingReference);
    expect(() =>
      tx.markProcessed(undefined, now, Money.from({ amount: "100.00", currency: "BRL" })),
    ).toThrow(/reference_transaction_id/);
    tx.markProcessed("ref-id", now, Money.from({ amount: "100.00", currency: "BRL" }));
    expect(tx.status).toBe(WagerTransactionStatus.Processed);
  });

  test("PROCESSED REFUND/ROLLBACK refuses null reference_transaction_id", () => {
    const refund = WagerTransaction.create({
      ...base,
      id: "t-refund",
      externalTransactionId: "rf-1",
      idempotencyKey: "provider-a:rf-1",
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: "bet-1",
    });
    expect(() =>
      refund.markProcessed(
        undefined,
        new Date(),
        Money.from({ amount: "100.00", currency: "BRL" }),
      ),
    ).toThrow(InvalidTransactionStateError);

    const rollback = WagerTransaction.create({
      ...base,
      id: "t-rb",
      externalTransactionId: "rb-1",
      idempotencyKey: "provider-a:rb-1",
      kind: WagerTransactionKind.Rollback,
      referenceExternalTransactionId: "win-1",
    });
    expect(() =>
      rollback.markProcessed(
        undefined,
        new Date(),
        Money.from({ amount: "100.00", currency: "BRL" }),
      ),
    ).toThrow(/reference_transaction_id/);
  });

  test("ROLLBACK inverts reference direction", () => {
    const bet = WagerTransaction.create({ ...base, kind: WagerTransactionKind.Bet });
    const rollback = WagerTransaction.create({
      ...base,
      id: "t2",
      externalTransactionId: "rb-1",
      idempotencyKey: "provider-a:rb-1",
      kind: WagerTransactionKind.Rollback,
      referenceExternalTransactionId: "tx-1",
    });
    expect(rollback.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
  });

  test("canReference matrix", () => {
    expect(
      WagerTransaction.canReference(WagerTransactionKind.Refund, WagerTransactionKind.Bet),
    ).toBe(true);
    expect(
      WagerTransaction.canReference(WagerTransactionKind.Refund, WagerTransactionKind.Win),
    ).toBe(false);
    expect(
      WagerTransaction.canReference(WagerTransactionKind.Rollback, WagerTransactionKind.Win),
    ).toBe(true);
  });

  test("matchesPayload", () => {
    const tx = WagerTransaction.create({ ...base, kind: WagerTransactionKind.Bet });
    expect(tx.matchesPayload("abc")).toBe(true);
    expect(tx.matchesPayload("other")).toBe(false);
  });
});

describe("WalletLedgerEntry", () => {
  test("create validates arithmetic", () => {
    const entry = WalletLedgerEntry.create({
      id: "e1",
      walletId: "w1",
      transactionId: "t1",
      direction: LedgerDirection.Debit,
      money: Money.from({ amount: "25.00", currency: "BRL" }),
      balanceBefore: Money.from({ amount: "100.00", currency: "BRL" }),
      balanceAfter: Money.from({ amount: "75.00", currency: "BRL" }),
      createdAt: new Date(),
    });
    expect(entry.isBalanced()).toBe(true);
  });

  test("unbalanced entry is rejected", () => {
    expect(() =>
      WalletLedgerEntry.create({
        id: "e1",
        walletId: "w1",
        transactionId: "t1",
        direction: LedgerDirection.Credit,
        money: Money.from({ amount: "10.00", currency: "BRL" }),
        balanceBefore: Money.from({ amount: "0.00", currency: "BRL" }),
        balanceAfter: Money.from({ amount: "5.00", currency: "BRL" }),
        createdAt: new Date(),
      }),
    ).toThrow(DomainError);
  });
});
