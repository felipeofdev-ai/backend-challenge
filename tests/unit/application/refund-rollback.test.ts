import { describe, expect, test } from "bun:test";
import { InMemoryUnitOfWork } from "../../../src/infrastructure/persistence/in-memory.unit-of-work";
import { OutboxPublisher } from "../../../src/infrastructure/sqs/outbox-publisher";
import type { SqsMessagingAdapter } from "../../../src/infrastructure/sqs/sqs.adapter";
import { newId } from "../../../src/shared/id";
import { SystemClock } from "../../../src/wagering/application/ports/repositories";
import { CreateWalletUseCase } from "../../../src/wagering/application/use-cases/create-wallet.use-case";
import { ProcessWagerUseCase } from "../../../src/wagering/application/use-cases/process-wager.use-case";
import { ReprocessPendingReferencesUseCase } from "../../../src/wagering/application/use-cases/reprocess-pending.use-case";
import { FailureCode, WagerTransactionStatus } from "../../../src/wagering/domain";

function setup() {
  const uow = new InMemoryUnitOfWork();
  const clock = new SystemClock();
  return {
    uow,
    clock,
    createWallet: new CreateWalletUseCase(uow, clock),
    processWager: new ProcessWagerUseCase(uow, clock),
    reprocess: new ReprocessPendingReferencesUseCase(uow, clock),
  };
}

describe("REFUND / ROLLBACK / PENDING_REFERENCE", () => {
  test("REFUND of BET credits stake once", async () => {
    const { createWallet, processWager, uow } = setup();
    const playerId = newId();
    const wallet = await createWallet.execute({
      playerId,
      initialBalance: { amount: "100.00", currency: "BRL" },
    });

    await processWager.execute({
      providerId: "provider-a",
      externalTransactionId: "bet-1",
      idempotencyKey: "provider-a:bet-1",
      playerId,
      walletId: wallet.id,
      roundId: "round-1",
      gameId: "game",
      kind: "BET",
      money: { amount: "40.00", currency: "BRL" },
    });

    const refund = await processWager.execute({
      providerId: "provider-a",
      externalTransactionId: "refund-1",
      idempotencyKey: "provider-a:refund-1",
      playerId,
      walletId: wallet.id,
      roundId: "round-1",
      gameId: "game",
      kind: "REFUND",
      money: { amount: "40.00", currency: "BRL" },
      referenceExternalTransactionId: "bet-1",
    });

    expect(refund.status).toBe(WagerTransactionStatus.Processed);
    expect(refund.balance?.amount).toBe("100.00");
    expect(uow.store.wallets.get(wallet.id)!.balance.toString()).toBe("100.00");
  });

  test("second REFUND of same BET is rejected", async () => {
    const { createWallet, processWager } = setup();
    const playerId = newId();
    const wallet = await createWallet.execute({
      playerId,
      initialBalance: { amount: "100.00", currency: "BRL" },
    });

    await processWager.execute({
      providerId: "provider-a",
      externalTransactionId: "bet-1",
      idempotencyKey: "provider-a:bet-1",
      playerId,
      walletId: wallet.id,
      roundId: "round-1",
      gameId: "game",
      kind: "BET",
      money: { amount: "40.00", currency: "BRL" },
    });

    await processWager.execute({
      providerId: "provider-a",
      externalTransactionId: "refund-1",
      idempotencyKey: "provider-a:refund-1",
      playerId,
      walletId: wallet.id,
      roundId: "round-1",
      gameId: "game",
      kind: "REFUND",
      money: { amount: "40.00", currency: "BRL" },
      referenceExternalTransactionId: "bet-1",
    });

    const second = await processWager.execute({
      providerId: "provider-a",
      externalTransactionId: "refund-2",
      idempotencyKey: "provider-a:refund-2",
      playerId,
      walletId: wallet.id,
      roundId: "round-1",
      gameId: "game",
      kind: "REFUND",
      money: { amount: "40.00", currency: "BRL" },
      referenceExternalTransactionId: "bet-1",
    });

    expect(second.status).toBe(WagerTransactionStatus.Rejected);
    expect(second.failureCode).toBe(FailureCode.REFERENCE_ALREADY_REVERSED);
  });

  test("ROLLBACK of WIN debits the win amount", async () => {
    const { createWallet, processWager } = setup();
    const playerId = newId();
    const wallet = await createWallet.execute({
      playerId,
      initialBalance: { amount: "100.00", currency: "BRL" },
    });

    await processWager.execute({
      providerId: "provider-a",
      externalTransactionId: "bet-1",
      idempotencyKey: "provider-a:bet-1",
      playerId,
      walletId: wallet.id,
      roundId: "round-1",
      gameId: "game",
      kind: "BET",
      money: { amount: "20.00", currency: "BRL" },
    });

    await processWager.execute({
      providerId: "provider-a",
      externalTransactionId: "win-1",
      idempotencyKey: "provider-a:win-1",
      playerId,
      walletId: wallet.id,
      roundId: "round-1",
      gameId: "game",
      kind: "WIN",
      money: { amount: "50.00", currency: "BRL" },
    });

    const rb = await processWager.execute({
      providerId: "provider-a",
      externalTransactionId: "rb-1",
      idempotencyKey: "provider-a:rb-1",
      playerId,
      walletId: wallet.id,
      roundId: "round-1",
      gameId: "game",
      kind: "ROLLBACK",
      money: { amount: "50.00", currency: "BRL" },
      referenceExternalTransactionId: "win-1",
    });

    expect(rb.status).toBe(WagerTransactionStatus.Processed);
    expect(rb.balance?.amount).toBe("80.00"); // 100 - 20 + 50 - 50
  });

  test("ROLLBACK of WIN that would go negative → ROLLBACK_WOULD_OVERDRAW", async () => {
    const { createWallet, processWager } = setup();
    const playerId = newId();
    const wallet = await createWallet.execute({
      playerId,
      initialBalance: { amount: "100.00", currency: "BRL" },
    });

    await processWager.execute({
      providerId: "provider-a",
      externalTransactionId: "bet-1",
      idempotencyKey: "provider-a:bet-1",
      playerId,
      walletId: wallet.id,
      roundId: "round-1",
      gameId: "game",
      kind: "BET",
      money: { amount: "100.00", currency: "BRL" },
    });
    await processWager.execute({
      providerId: "provider-a",
      externalTransactionId: "win-1",
      idempotencyKey: "provider-a:win-1",
      playerId,
      walletId: wallet.id,
      roundId: "round-1",
      gameId: "game",
      kind: "WIN",
      money: { amount: "40.00", currency: "BRL" },
    });
    // Spend the win so ROLLBACK debit cannot apply
    await processWager.execute({
      providerId: "provider-a",
      externalTransactionId: "bet-2",
      idempotencyKey: "provider-a:bet-2",
      playerId,
      walletId: wallet.id,
      roundId: "round-2",
      gameId: "game",
      kind: "BET",
      money: { amount: "40.00", currency: "BRL" },
    });

    const rb = await processWager.execute({
      providerId: "provider-a",
      externalTransactionId: "rb-over",
      idempotencyKey: "provider-a:rb-over",
      playerId,
      walletId: wallet.id,
      roundId: "round-1",
      gameId: "game",
      kind: "ROLLBACK",
      money: { amount: "40.00", currency: "BRL" },
      referenceExternalTransactionId: "win-1",
    });

    expect(rb.status).toBe(WagerTransactionStatus.Rejected);
    expect(rb.failureCode).toBe(FailureCode.ROLLBACK_WOULD_OVERDRAW);
    expect(rb.balance?.amount).toBe("0.00");
  });

  test("executeFromQueue keeps inbox + financial in one outcome", async () => {
    const { createWallet, processWager, uow } = setup();
    const playerId = newId();
    const wallet = await createWallet.execute({
      playerId,
      initialBalance: { amount: "80.00", currency: "BRL" },
    });
    const messageId = newId();
    const externalTransactionId = `q-${newId()}`;
    const payloadHash = "abc";

    const first = await processWager.executeFromQueue(
      {
        providerId: "provider-q",
        externalTransactionId,
        idempotencyKey: `provider-q:${externalTransactionId}`,
        playerId,
        walletId: wallet.id,
        roundId: "r",
        gameId: "g",
        kind: "BET",
        money: { amount: "15.00", currency: "BRL" },
      },
      { consumerName: "wager-consumer", messageId, payloadHash },
    );
    expect(first.kind).toBe("processed");

    const inbox = await uow.transactional((repos) => repos.inbox.find("wager-consumer", messageId));
    expect(inbox?.isProcessed()).toBe(true);

    const second = await processWager.executeFromQueue(
      {
        providerId: "provider-q",
        externalTransactionId,
        idempotencyKey: `provider-q:${externalTransactionId}`,
        playerId,
        walletId: wallet.id,
        roundId: "r",
        gameId: "g",
        kind: "BET",
        money: { amount: "15.00", currency: "BRL" },
      },
      { consumerName: "wager-consumer", messageId, payloadHash },
    );
    expect(second.kind).toBe("duplicate");
    expect(uow.store.wallets.get(wallet.id)!.balance.toString()).toBe("65.00");
  });

  test("REFUND before BET → PENDING_REFERENCE → worker resolves after BET", async () => {
    const { createWallet, processWager, reprocess, uow } = setup();
    const playerId = newId();
    const wallet = await createWallet.execute({
      playerId,
      initialBalance: { amount: "100.00", currency: "BRL" },
    });

    const pending = await processWager.execute({
      providerId: "provider-a",
      externalTransactionId: "refund-early",
      idempotencyKey: "provider-a:refund-early",
      playerId,
      walletId: wallet.id,
      roundId: "round-1",
      gameId: "game",
      kind: "REFUND",
      money: { amount: "30.00", currency: "BRL" },
      referenceExternalTransactionId: "bet-late",
    });
    expect(pending.status).toBe(WagerTransactionStatus.PendingReference);

    await processWager.execute({
      providerId: "provider-a",
      externalTransactionId: "bet-late",
      idempotencyKey: "provider-a:bet-late",
      playerId,
      walletId: wallet.id,
      roundId: "round-1",
      gameId: "game",
      kind: "BET",
      money: { amount: "30.00", currency: "BRL" },
    });

    // Force due now (past nextReprocessAt) so the pending worker picks it up
    const tx = [...uow.store.transactions.values()].find(
      (t) => t.externalTransactionId === "refund-early",
    )!;
    tx.scheduleReferenceRetry(new Date(), new Date(Date.now() - 1000));
    expect(tx.nextReprocessAt!.getTime()).toBeLessThanOrEqual(Date.now());

    const result = await reprocess.execute(10);
    expect(result.processed).toBe(1);

    const after = uow.store.transactions.get(tx.id)!;
    expect(after.status).toBe(WagerTransactionStatus.Processed);
    expect(uow.store.wallets.get(wallet.id)!.balance.toString()).toBe("100.00");
  });
});

describe("OutboxPublisher", () => {
  test("publishes due messages and marks published_at", async () => {
    const { uow, clock, createWallet } = setup();
    await createWallet.execute({
      playerId: newId(),
      initialBalance: { amount: "10.00", currency: "BRL" },
    });
    expect(uow.store.outbox.length).toBeGreaterThan(0);

    const publishedBodies: string[] = [];
    const fakeSqs = {
      publishEvent: async (body: string) => {
        publishedBodies.push(body);
      },
    } as unknown as SqsMessagingAdapter;

    const publisher = new OutboxPublisher(uow, fakeSqs, clock, 60_000);
    const n = await publisher.publishBatch(100);
    expect(n).toBeGreaterThan(0);
    expect(publishedBodies.length).toBe(n);
    expect(uow.store.outbox.every((m) => m.publishedAt !== undefined)).toBe(true);
  });
});
