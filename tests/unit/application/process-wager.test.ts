import { describe, expect, test } from "bun:test";
import { InMemoryUnitOfWork } from "../../../src/infrastructure/persistence/in-memory.unit-of-work";
import { newId } from "../../../src/shared/id";
import { SystemClock } from "../../../src/wagering/application/ports/repositories";
import { CreateWalletUseCase } from "../../../src/wagering/application/use-cases/create-wallet.use-case";
import { ProcessWagerUseCase } from "../../../src/wagering/application/use-cases/process-wager.use-case";
import { FailureCode, WagerTransactionStatus } from "../../../src/wagering/domain";
import { DomainError } from "../../../src/wagering/domain/errors";

function setup() {
  const uow = new InMemoryUnitOfWork();
  const clock = new SystemClock();
  const createWallet = new CreateWalletUseCase(uow, clock);
  const processWager = new ProcessWagerUseCase(uow, clock);
  return { uow, createWallet, processWager };
}

describe("ProcessWagerUseCase", () => {
  test("BET debits balance and writes ledger + outbox", async () => {
    const { uow, createWallet, processWager } = setup();
    const playerId = newId();
    const wallet = await createWallet.execute({
      playerId,
      initialBalance: { amount: "100.00", currency: "BRL" },
    });

    const result = await processWager.execute({
      providerId: "provider-a",
      externalTransactionId: "bet-1",
      idempotencyKey: "provider-a:bet-1",
      playerId,
      walletId: wallet.id,
      roundId: "round-1",
      gameId: "fortune-chimp",
      kind: "BET",
      money: { amount: "25.00", currency: "BRL" },
    });

    expect(result.status).toBe(WagerTransactionStatus.Processed);
    expect(result.balance?.amount).toBe("75.00");
    expect(result.idempotentReplay).toBe(false);
    expect(uow.store.ledger.filter((e) => e.walletId === wallet.id).length).toBe(2); // OPENING + BET
  });

  test("scenario §8: two concurrent 80 BETs on 100 → 1 PROCESSED, 1 REJECTED, balance 20", async () => {
    const { uow, createWallet, processWager } = setup();
    const playerId = newId();
    const wallet = await createWallet.execute({
      playerId,
      initialBalance: { amount: "100.00", currency: "BRL" },
    });

    const [a, b] = await Promise.all([
      processWager.execute({
        providerId: "provider-a",
        externalTransactionId: "bet-a",
        idempotencyKey: "provider-a:bet-a",
        playerId,
        walletId: wallet.id,
        roundId: "round-race",
        gameId: "fortune-chimp",
        kind: "BET",
        money: { amount: "80.00", currency: "BRL" },
      }),
      processWager.execute({
        providerId: "provider-a",
        externalTransactionId: "bet-b",
        idempotencyKey: "provider-a:bet-b",
        playerId,
        walletId: wallet.id,
        roundId: "round-race",
        gameId: "fortune-chimp",
        kind: "BET",
        money: { amount: "80.00", currency: "BRL" },
      }),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([WagerTransactionStatus.Processed, WagerTransactionStatus.Rejected]);
    const rejected = a.status === WagerTransactionStatus.Rejected ? a : b;
    expect(rejected.failureCode).toBe(FailureCode.INSUFFICIENT_BALANCE);

    const stored = uow.store.wallets.get(wallet.id)!;
    expect(stored.balance.toString()).toBe("20.00");

    const debitEntries = uow.store.ledger.filter(
      (e) => e.walletId === wallet.id && e.direction === "DEBIT",
    );
    expect(debitEntries.length).toBe(1);
  });

  test("idempotent replay returns original balance", async () => {
    const { createWallet, processWager } = setup();
    const playerId = newId();
    const wallet = await createWallet.execute({
      playerId,
      initialBalance: { amount: "100.00", currency: "BRL" },
    });

    const input = {
      providerId: "provider-a",
      externalTransactionId: "bet-1",
      idempotencyKey: "provider-a:bet-1",
      playerId,
      walletId: wallet.id,
      roundId: "round-1",
      gameId: "fortune-chimp",
      kind: "BET",
      money: { amount: "10.00", currency: "BRL" },
    };

    const first = await processWager.execute(input);
    const second = await processWager.execute(input);
    expect(second.idempotentReplay).toBe(true);
    expect(second.transactionId).toBe(first.transactionId);
    expect(second.balance?.amount).toBe("90.00");
  });

  test("same key different payload → IDEMPOTENCY_CONFLICT", async () => {
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
      gameId: "fortune-chimp",
      kind: "BET",
      money: { amount: "10.00", currency: "BRL" },
    });

    await expect(
      processWager.execute({
        providerId: "provider-a",
        externalTransactionId: "bet-1",
        idempotencyKey: "provider-a:bet-1",
        playerId,
        walletId: wallet.id,
        roundId: "round-1",
        gameId: "fortune-chimp",
        kind: "BET",
        money: { amount: "11.00", currency: "BRL" },
      }),
    ).rejects.toBeInstanceOf(DomainError);
  });

  test("LOSS does not move balance or add ledger entry", async () => {
    const { uow, createWallet, processWager } = setup();
    const playerId = newId();
    const wallet = await createWallet.execute({
      playerId,
      initialBalance: { amount: "50.00", currency: "BRL" },
    });
    const ledgerBefore = uow.store.ledger.length;

    const result = await processWager.execute({
      providerId: "provider-a",
      externalTransactionId: "loss-1",
      idempotencyKey: "provider-a:loss-1",
      playerId,
      walletId: wallet.id,
      roundId: "round-1",
      gameId: "fortune-chimp",
      kind: "LOSS",
      money: { amount: "50.00", currency: "BRL" },
    });

    expect(result.status).toBe(WagerTransactionStatus.Processed);
    expect(result.balance?.amount).toBe("50.00");
    expect(uow.store.wallets.get(wallet.id)!.version).toBe(1);
    expect(uow.store.ledger.length).toBe(ledgerBefore);
  });

  test("REFUND before BET → PENDING_REFERENCE", async () => {
    const { createWallet, processWager } = setup();
    const playerId = newId();
    const wallet = await createWallet.execute({
      playerId,
      initialBalance: { amount: "100.00", currency: "BRL" },
    });

    const result = await processWager.execute({
      providerId: "provider-a",
      externalTransactionId: "refund-1",
      idempotencyKey: "provider-a:refund-1",
      playerId,
      walletId: wallet.id,
      roundId: "round-1",
      gameId: "fortune-chimp",
      kind: "REFUND",
      money: { amount: "25.00", currency: "BRL" },
      referenceExternalTransactionId: "bet-missing",
    });

    expect(result.status).toBe(WagerTransactionStatus.PendingReference);
    expect(result.httpHint).toBe("accepted");
  });

  test("WIN credits balance", async () => {
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
      gameId: "fortune-chimp",
      kind: "BET",
      money: { amount: "20.00", currency: "BRL" },
    });

    const win = await processWager.execute({
      providerId: "provider-a",
      externalTransactionId: "win-1",
      idempotencyKey: "provider-a:win-1",
      playerId,
      walletId: wallet.id,
      roundId: "round-1",
      gameId: "fortune-chimp",
      kind: "WIN",
      money: { amount: "50.00", currency: "BRL" },
    });

    expect(win.balance?.amount).toBe("130.00");
  });
});
