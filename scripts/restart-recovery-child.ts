/**
 * Child that commits a BET then sleeps (simulating post-commit pre-ack window),
 * so the parent can SIGKILL and prove restart/idempotent recovery.
 *
 * Args: walletId playerId externalTransactionId sleepMs
 */
import { MikroORM } from "@mikro-orm/postgresql";
import config from "../mikro-orm.config";
import { MikroOrmUnitOfWork } from "../src/infrastructure/persistence/mikro-orm.unit-of-work";
import { SystemClock } from "../src/wagering/application/ports/repositories";
import { ProcessWagerUseCase } from "../src/wagering/application/use-cases/process-wager.use-case";

const walletId = process.argv[2]!;
const playerId = process.argv[3]!;
const externalTransactionId = process.argv[4]!;
const sleepMs = Number(process.argv[5] ?? 5_000);

process.env["DATABASE_PORT"] = process.env["DATABASE_PORT"] ?? "5433";

async function main(): Promise<void> {
  const orm = await MikroORM.init({ ...config, debug: false });
  const uow = new MikroOrmUnitOfWork(orm.em.fork());
  const processWager = new ProcessWagerUseCase(uow, new SystemClock());

  const result = await processWager.execute({
    providerId: "provider-restart",
    externalTransactionId,
    idempotencyKey: `provider-restart:${externalTransactionId}`,
    playerId,
    walletId,
    roundId: "restart",
    gameId: "g",
    kind: "BET",
    money: { amount: "7.00", currency: "BRL" },
  });

  console.log(
    JSON.stringify({
      msg: "committed_before_ack_window",
      transactionId: result.transactionId,
      status: result.status,
      balance: result.balance,
    }),
  );

  // Hold the process open — parent will SIGKILL during this window
  await new Promise((r) => setTimeout(r, sleepMs));
  console.log(JSON.stringify({ msg: "ack_would_happen_here" }));
  await orm.close(true);
}

main().catch((err) => {
  console.error(String(err));
  process.exit(1);
});
