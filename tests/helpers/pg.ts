import { MikroORM } from "@mikro-orm/postgresql";
import config from "../../mikro-orm.config";
import { MikroOrmUnitOfWork } from "../../src/infrastructure/persistence/mikro-orm.unit-of-work";
import { SystemClock } from "../../src/wagering/application/ports/repositories";
import { CreateWalletUseCase } from "../../src/wagering/application/use-cases/create-wallet.use-case";
import { ProcessWagerUseCase } from "../../src/wagering/application/use-cases/process-wager.use-case";
import { Money } from "../../src/wagering/domain/value-objects/money";

/**
 * Probe Postgres. When REQUIRE_INFRA=1 (CI), unreachable infra fails the suite
 * instead of silently skipping integration/concurrency/load/chaos.
 */
export async function postgresAvailable(): Promise<boolean> {
  try {
    await withOrm(async () => undefined);
    return true;
  } catch (err) {
    if (process.env["REQUIRE_INFRA"] === "1") {
      throw new Error(`REQUIRE_INFRA=1 but PostgreSQL is unreachable: ${String(err)}`);
    }
    return false;
  }
}

export async function withOrm<T>(
  fn: (ctx: {
    orm: MikroORM;
    uow: MikroOrmUnitOfWork;
    createWallet: CreateWalletUseCase;
    processWager: ProcessWagerUseCase;
  }) => Promise<T>,
): Promise<T> {
  process.env["DATABASE_PORT"] = process.env["DATABASE_PORT"] ?? "5433";
  const orm = await MikroORM.init({ ...config, debug: false });
  const uow = new MikroOrmUnitOfWork(orm.em.fork());
  const clock = new SystemClock();
  try {
    return await fn({
      orm,
      uow,
      createWallet: new CreateWalletUseCase(uow, clock),
      processWager: new ProcessWagerUseCase(uow, clock),
    });
  } finally {
    await orm.close(true);
  }
}

export async function assertLedgerReconciliation(
  uow: MikroOrmUnitOfWork,
  walletId: string,
): Promise<void> {
  await uow.transactional(async (repos) => {
    const wallet = await repos.wallets.findById(walletId);
    if (!wallet) throw new Error(`wallet ${walletId} missing`);
    const sums = await repos.ledger.sumBalanceFromLedger(walletId);
    const credit = Money.from({ amount: sums.credit, currency: wallet.currency });
    const debit = Money.from({ amount: sums.debit, currency: wallet.currency });
    const calculated = credit.subtract(debit);
    if (!calculated.equals(wallet.balance)) {
      throw new Error(
        `ledger mismatch wallet=${walletId} stored=${wallet.balance.toString()} calculated=${calculated.toString()}`,
      );
    }
  });
}
