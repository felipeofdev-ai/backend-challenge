/**
 * Child process for concurrency harness — places N independent 10.00 BETs.
 */
import { MikroORM } from "@mikro-orm/postgresql";
import config from "../mikro-orm.config";
import { MikroOrmUnitOfWork } from "../src/infrastructure/persistence/mikro-orm.unit-of-work";
import { SystemClock } from "../src/wagering/application/ports/repositories";
import { ProcessWagerUseCase } from "../src/wagering/application/use-cases/process-wager.use-case";
import { newId } from "../src/shared/id";

const walletId = process.argv[2]!;
const playerId = process.argv[3]!;
const instance = process.argv[4]!;
const bets = Number(process.argv[5] ?? 5);

process.env["DATABASE_PORT"] = process.env["DATABASE_PORT"] ?? "5433";

async function main(): Promise<void> {
  const orm = await MikroORM.init({ ...config, debug: false });
  const uow = new MikroOrmUnitOfWork(orm.em.fork());
  const processWager = new ProcessWagerUseCase(uow, new SystemClock());

  const results = await Promise.all(
    Array.from({ length: bets }, async (_, i) => {
      const externalTransactionId = `i${instance}-bet-${i}-${newId()}`;
      return processWager.execute({
        providerId: "provider-a",
        externalTransactionId,
        idempotencyKey: `provider-a:${externalTransactionId}`,
        playerId,
        walletId,
        roundId: `i${instance}`,
        gameId: "g",
        kind: "BET",
        money: { amount: "10.00", currency: "BRL" },
      });
    }),
  );

  const processed = results.filter((r) => r.status === "PROCESSED").length;
  console.log(
    JSON.stringify({
      msg: "instance_result",
      instance,
      processed,
      total: results.length,
    }),
  );
  await orm.close(true);
  if (processed !== bets) process.exit(2);
}

main().catch((err) => {
  console.error(String(err));
  process.exit(1);
});
