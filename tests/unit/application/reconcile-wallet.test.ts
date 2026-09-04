import { describe, expect, test } from "bun:test";
import { InMemoryUnitOfWork } from "../../../src/infrastructure/persistence/in-memory.unit-of-work";
import { newId } from "../../../src/shared/id";
import { SystemClock } from "../../../src/wagering/application/ports/repositories";
import { CreateWalletUseCase } from "../../../src/wagering/application/use-cases/create-wallet.use-case";
import { ProcessWagerUseCase } from "../../../src/wagering/application/use-cases/process-wager.use-case";
import { ReconcileWalletUseCase } from "../../../src/wagering/application/use-cases/reconcile-wallet.use-case";

describe("ReconcileWalletUseCase", () => {
  test("persists consistent check after BET", async () => {
    const uow = new InMemoryUnitOfWork();
    const clock = new SystemClock();
    const createWallet = new CreateWalletUseCase(uow, clock);
    const processWager = new ProcessWagerUseCase(uow, clock);
    const reconcile = new ReconcileWalletUseCase(uow, clock);

    const playerId = newId();
    const wallet = await createWallet.execute({
      playerId,
      initialBalance: { amount: "100.00", currency: "BRL" },
    });
    await processWager.execute({
      providerId: "p",
      externalTransactionId: "e1",
      idempotencyKey: "p:e1",
      playerId,
      walletId: wallet.id,
      roundId: "r",
      gameId: "g",
      kind: "BET",
      money: { amount: "10.00", currency: "BRL" },
    });

    const result = await reconcile.execute(wallet.id);
    expect(result.consistent).toBe(true);
    expect(result.storedBalance.amount).toBe("90.00");
    expect(uow.store.reconciliation).toHaveLength(1);
    expect(uow.store.reconciliation[0]!.consistent).toBe(true);
  });
});
