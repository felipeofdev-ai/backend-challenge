import { describe, expect, test } from "bun:test";
import { InMemoryUnitOfWork } from "../../src/infrastructure/persistence/in-memory.unit-of-work";
import { InboxMessage } from "../../src/messaging/domain/inbox-message";
import { newId } from "../../src/shared/id";
import { SystemClock } from "../../src/wagering/application/ports/repositories";
import { CreateWalletUseCase } from "../../src/wagering/application/use-cases/create-wallet.use-case";
import { ProcessWagerUseCase } from "../../src/wagering/application/use-cases/process-wager.use-case";
import { ReconcileWalletUseCase } from "../../src/wagering/application/use-cases/reconcile-wallet.use-case";
import { ReprocessPendingReferencesUseCase } from "../../src/wagering/application/use-cases/reprocess-pending.use-case";
import { DomainError, FailureCode, WagerTransactionStatus } from "../../src/wagering/domain";

function setup() {
  const uow = new InMemoryUnitOfWork();
  const clock = new SystemClock();
  return {
    uow,
    clock,
    createWallet: new CreateWalletUseCase(uow, clock),
    processWager: new ProcessWagerUseCase(uow, clock),
    reprocess: new ReprocessPendingReferencesUseCase(uow, clock),
    reconcile: new ReconcileWalletUseCase(uow, clock),
  };
}

async function openWallet(createWallet: CreateWalletUseCase, balance = "1000.00") {
  const playerId = newId();
  const wallet = await createWallet.execute({
    playerId,
    initialBalance: { amount: balance, currency: "BRL" },
  });
  return { playerId, wallet };
}

describe("forensic · global invariants (in-memory)", () => {
  test("I1/I2 — never duplicate debit or credit for same idempotency key (200×)", async () => {
    const { createWallet, processWager, uow, reconcile } = setup();
    const { playerId, wallet } = await openWallet(createWallet, "500.00");
    const externalTransactionId = `dup-${newId()}`;
    const input = {
      providerId: "provider-a",
      externalTransactionId,
      idempotencyKey: `provider-a:${externalTransactionId}`,
      playerId,
      walletId: wallet.id,
      roundId: "r",
      gameId: "g",
      kind: "BET" as const,
      money: { amount: "10.00", currency: "BRL" },
    };

    const results = await Promise.all(
      Array.from({ length: 200 }, () => processWager.execute(input)),
    );

    expect(results.every((r) => r.status === WagerTransactionStatus.Processed)).toBe(true);
    expect(results.filter((r) => !r.idempotentReplay)).toHaveLength(1);
    expect(new Set(results.map((r) => r.transactionId)).size).toBe(1);
    expect(uow.store.ledger.filter((e) => e.direction === "DEBIT")).toHaveLength(1);
    expect(uow.store.wallets.get(wallet.id)!.balance.toString()).toBe("490.00");

    const rec = await reconcile.execute(wallet.id);
    expect(rec.consistent).toBe(true);
  });

  test("I4 — never negative balance under parallel overdraft storm", async () => {
    const { createWallet, processWager, uow, reconcile } = setup();
    const { playerId, wallet } = await openWallet(createWallet, "100.00");

    const results = await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        processWager.execute({
          providerId: "provider-a",
          externalTransactionId: `storm-${i}-${newId()}`,
          idempotencyKey: `provider-a:storm-${i}-${newId()}`,
          playerId,
          walletId: wallet.id,
          roundId: "storm",
          gameId: "g",
          kind: "BET",
          money: { amount: "30.00", currency: "BRL" },
        }),
      ),
    );

    const processed = results.filter((r) => r.status === WagerTransactionStatus.Processed);
    const rejected = results.filter((r) => r.status === WagerTransactionStatus.Rejected);
    expect(processed.length).toBe(3);
    expect(rejected.length).toBe(37);
    expect(rejected.every((r) => r.failureCode === FailureCode.INSUFFICIENT_BALANCE)).toBe(true);
    expect(uow.store.wallets.get(wallet.id)!.balance.toString()).toBe("10.00");
    expect(uow.store.wallets.get(wallet.id)!.balance.isNegative()).toBe(false);
    expect((await reconcile.execute(wallet.id)).consistent).toBe(true);
  });

  test("I3 — every PROCESSED balance-affecting tx emits outbox (no lost confirmed events)", async () => {
    const { createWallet, processWager, uow } = setup();
    const { playerId, wallet } = await openWallet(createWallet, "200.00");

    await processWager.execute({
      providerId: "p",
      externalTransactionId: "bet-1",
      idempotencyKey: "p:bet-1",
      playerId,
      walletId: wallet.id,
      roundId: "r",
      gameId: "g",
      kind: "BET",
      money: { amount: "20.00", currency: "BRL" },
    });
    await processWager.execute({
      providerId: "p",
      externalTransactionId: "win-1",
      idempotencyKey: "p:win-1",
      playerId,
      walletId: wallet.id,
      roundId: "r",
      gameId: "g",
      kind: "WIN",
      money: { amount: "50.00", currency: "BRL" },
      referenceExternalTransactionId: "bet-1",
    });

    const types = uow.store.outbox.map((o) => o.eventType);
    expect(types).toContain("WagerTransactionProcessed");
    expect(types).toContain("WalletBalanceChanged");
    expect(uow.store.outbox.every((o) => o.isPending() || o.publishedAt)).toBe(true);
  });
});

describe("forensic · lifecycle matrix", () => {
  test("BET → LOSS leaves balance unchanged and writes no extra ledger debit", async () => {
    const { createWallet, processWager, uow } = setup();
    const { playerId, wallet } = await openWallet(createWallet, "80.00");
    await processWager.execute({
      providerId: "p",
      externalTransactionId: "b1",
      idempotencyKey: "p:b1",
      playerId,
      walletId: wallet.id,
      roundId: "r",
      gameId: "g",
      kind: "BET",
      money: { amount: "25.00", currency: "BRL" },
    });
    const loss = await processWager.execute({
      providerId: "p",
      externalTransactionId: "l1",
      idempotencyKey: "p:l1",
      playerId,
      walletId: wallet.id,
      roundId: "r",
      gameId: "g",
      kind: "LOSS",
      money: { amount: "25.00", currency: "BRL" },
    });
    expect(loss.status).toBe(WagerTransactionStatus.Processed);
    expect(uow.store.wallets.get(wallet.id)!.balance.toString()).toBe("55.00");
    expect(uow.store.wallets.get(wallet.id)!.version).toBe(2); // open+bet only
    expect(uow.store.ledger.filter((e) => e.direction === "DEBIT")).toHaveLength(1);
  });

  test("BET → WIN credits exact stake payout", async () => {
    const { createWallet, processWager, reconcile } = setup();
    const { playerId, wallet } = await openWallet(createWallet, "100.00");
    await processWager.execute({
      providerId: "p",
      externalTransactionId: "b1",
      idempotencyKey: "p:b1",
      playerId,
      walletId: wallet.id,
      roundId: "r",
      gameId: "g",
      kind: "BET",
      money: { amount: "10.00", currency: "BRL" },
    });
    const win = await processWager.execute({
      providerId: "p",
      externalTransactionId: "w1",
      idempotencyKey: "p:w1",
      playerId,
      walletId: wallet.id,
      roundId: "r",
      gameId: "g",
      kind: "WIN",
      money: { amount: "35.50", currency: "BRL" },
      referenceExternalTransactionId: "b1",
    });
    expect(win.balance?.amount).toBe("125.50");
    expect((await reconcile.execute(wallet.id)).consistent).toBe(true);
  });

  test("out-of-order REFUND then BET resolves via pending worker", async () => {
    const { createWallet, processWager, reprocess, uow, reconcile } = setup();
    const { playerId, wallet } = await openWallet(createWallet, "100.00");

    const refund = await processWager.execute({
      providerId: "p",
      externalTransactionId: "rf1",
      idempotencyKey: "p:rf1",
      playerId,
      walletId: wallet.id,
      roundId: "r",
      gameId: "g",
      kind: "REFUND",
      money: { amount: "15.00", currency: "BRL" },
      referenceExternalTransactionId: "late-bet",
    });
    expect(refund.status).toBe(WagerTransactionStatus.PendingReference);

    await processWager.execute({
      providerId: "p",
      externalTransactionId: "late-bet",
      idempotencyKey: "p:late-bet",
      playerId,
      walletId: wallet.id,
      roundId: "r",
      gameId: "g",
      kind: "BET",
      money: { amount: "15.00", currency: "BRL" },
    });
    expect(uow.store.wallets.get(wallet.id)!.balance.toString()).toBe("85.00");

    const pending = [...uow.store.transactions.values()].find(
      (t) => t.externalTransactionId === "rf1",
    )!;
    pending.scheduleReferenceRetry(new Date(), new Date(Date.now() - 1000));

    const tick = await reprocess.execute(10);
    expect(tick.processed).toBe(1);
    expect(uow.store.wallets.get(wallet.id)!.balance.toString()).toBe("100.00");
    expect((await reconcile.execute(wallet.id)).consistent).toBe(true);
  });

  test("WIN ROLLBACK restores pre-win balance; second rollback rejected", async () => {
    const { createWallet, processWager, uow } = setup();
    const { playerId, wallet } = await openWallet(createWallet, "100.00");
    await processWager.execute({
      providerId: "p",
      externalTransactionId: "b1",
      idempotencyKey: "p:b1",
      playerId,
      walletId: wallet.id,
      roundId: "r",
      gameId: "g",
      kind: "BET",
      money: { amount: "20.00", currency: "BRL" },
    });
    await processWager.execute({
      providerId: "p",
      externalTransactionId: "w1",
      idempotencyKey: "p:w1",
      playerId,
      walletId: wallet.id,
      roundId: "r",
      gameId: "g",
      kind: "WIN",
      money: { amount: "60.00", currency: "BRL" },
      referenceExternalTransactionId: "b1",
    });
    expect(uow.store.wallets.get(wallet.id)!.balance.toString()).toBe("140.00");

    const rb = await processWager.execute({
      providerId: "p",
      externalTransactionId: "rb1",
      idempotencyKey: "p:rb1",
      playerId,
      walletId: wallet.id,
      roundId: "r",
      gameId: "g",
      kind: "ROLLBACK",
      money: { amount: "60.00", currency: "BRL" },
      referenceExternalTransactionId: "w1",
    });
    expect(rb.status).toBe(WagerTransactionStatus.Processed);
    expect(uow.store.wallets.get(wallet.id)!.balance.toString()).toBe("80.00");

    const rb2 = await processWager.execute({
      providerId: "p",
      externalTransactionId: "rb2",
      idempotencyKey: "p:rb2",
      playerId,
      walletId: wallet.id,
      roundId: "r",
      gameId: "g",
      kind: "ROLLBACK",
      money: { amount: "60.00", currency: "BRL" },
      referenceExternalTransactionId: "w1",
    });
    expect(rb2.status).toBe(WagerTransactionStatus.Rejected);
    expect(rb2.failureCode).toBe(FailureCode.REFERENCE_ALREADY_REVERSED);
  });

  test("currency mismatch on BET is rejected without mutating balance", async () => {
    const { createWallet, processWager, uow } = setup();
    const { playerId, wallet } = await openWallet(createWallet, "50.00");
    const r = await processWager.execute({
      providerId: "p",
      externalTransactionId: "usd",
      idempotencyKey: "p:usd",
      playerId,
      walletId: wallet.id,
      roundId: "r",
      gameId: "g",
      kind: "BET",
      money: { amount: "10.00", currency: "USD" },
    });
    expect(r.status).toBe(WagerTransactionStatus.Rejected);
    expect(r.failureCode).toBe(FailureCode.WALLET_CURRENCY_MISMATCH);
    expect(uow.store.wallets.get(wallet.id)!.balance.toString()).toBe("50.00");
    expect(uow.store.ledger.filter((e) => e.direction === "DEBIT")).toHaveLength(0);
  });

  test("OPENING via ProcessWager is KIND_NOT_ALLOWED", async () => {
    const { createWallet, processWager } = setup();
    const { playerId, wallet } = await openWallet(createWallet);
    await expect(
      processWager.execute({
        providerId: "p",
        externalTransactionId: "op",
        idempotencyKey: "p:op",
        playerId,
        walletId: wallet.id,
        roundId: "r",
        gameId: "g",
        kind: "OPENING",
        money: { amount: "1.00", currency: "BRL" },
      }),
    ).rejects.toMatchObject({ code: FailureCode.KIND_NOT_ALLOWED });
  });

  test("idempotency conflict on payload mutation", async () => {
    const { createWallet, processWager } = setup();
    const { playerId, wallet } = await openWallet(createWallet);
    await processWager.execute({
      providerId: "p",
      externalTransactionId: "x1",
      idempotencyKey: "same-key",
      playerId,
      walletId: wallet.id,
      roundId: "r",
      gameId: "g",
      kind: "BET",
      money: { amount: "5.00", currency: "BRL" },
    });
    await expect(
      processWager.execute({
        providerId: "p",
        externalTransactionId: "x1",
        idempotencyKey: "same-key",
        playerId,
        walletId: wallet.id,
        roundId: "r",
        gameId: "g",
        kind: "BET",
        money: { amount: "6.00", currency: "BRL" },
      }),
    ).rejects.toBeInstanceOf(DomainError);
  });
});

describe("forensic · inbox semantics", () => {
  test("inbox tryReceive is once-only; markProcessed is idempotent", async () => {
    const { uow, clock } = setup();
    const msg = InboxMessage.receive({
      messageId: "m1",
      consumerName: "wager-consumer",
      payloadHash: "a".repeat(64),
      receivedAt: clock.now(),
    });
    const first = await uow.transactional((r) => r.inbox.tryReceive(msg));
    expect(first.created).toBe(true);
    const second = await uow.transactional((r) => r.inbox.tryReceive(msg));
    expect(second.created).toBe(false);

    await uow.transactional((r) => r.inbox.markProcessed("wager-consumer", "m1", clock.now()));
    await uow.transactional((r) => r.inbox.markProcessed("wager-consumer", "m1", clock.now()));
    const found = await uow.transactional((r) => r.inbox.find("wager-consumer", "m1"));
    expect(found?.isProcessed()).toBe(true);
  });
});
