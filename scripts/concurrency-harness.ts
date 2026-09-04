/**
 * Spawns N worker-like processes that each run concurrent BETs against the same wallet.
 * Proves correctness with ≥3 OS processes sharing PostgreSQL.
 *
 * Usage: bun run scripts/concurrency-harness.ts
 */
import { spawn } from "node:child_process";
import { MikroORM } from "@mikro-orm/postgresql";
import config from "../mikro-orm.config";
import { MikroOrmUnitOfWork } from "../src/infrastructure/persistence/mikro-orm.unit-of-work";
import { SystemClock } from "../src/wagering/application/ports/repositories";
import { CreateWalletUseCase } from "../src/wagering/application/use-cases/create-wallet.use-case";
import { newId } from "../src/shared/id";

process.env["DATABASE_PORT"] = process.env["DATABASE_PORT"] ?? "5433";

const INSTANCES = Number(process.env["CONCURRENCY_INSTANCES"] ?? 3);
const BETS_PER_INSTANCE = Number(process.env["CONCURRENCY_BETS"] ?? 5);

async function main(): Promise<void> {
  const orm = await MikroORM.init({ ...config, debug: false });
  const uow = new MikroOrmUnitOfWork(orm.em.fork());
  const createWallet = new CreateWalletUseCase(uow, new SystemClock());
  const playerId = newId();
  const wallet = await createWallet.execute({
    playerId,
    initialBalance: { amount: "1000.00", currency: "BRL" },
  });
  await orm.close(true);

  console.log(
    JSON.stringify({
      msg: "harness_wallet",
      walletId: wallet.id,
      playerId,
      instances: INSTANCES,
      betsPerInstance: BETS_PER_INSTANCE,
    }),
  );

  const children = Array.from({ length: INSTANCES }, (_, i) => {
    return new Promise<{ code: number | null; name: string }>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          "run",
          "scripts/concurrency-worker.ts",
          wallet.id,
          playerId,
          String(i),
          String(BETS_PER_INSTANCE),
        ],
        {
          cwd: process.cwd(),
          env: { ...process.env, DATABASE_PORT: process.env["DATABASE_PORT"] ?? "5433" },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let out = "";
      child.stdout.on("data", (d) => {
        out += String(d);
      });
      child.stderr.on("data", (d) => {
        out += String(d);
      });
      child.on("error", reject);
      child.on("close", (code) => {
        console.log(JSON.stringify({ msg: "instance_done", instance: i, code, out: out.trim() }));
        resolve({ code, name: `i${i}` });
      });
    });
  });

  const results = await Promise.all(children);
  if (results.some((r) => r.code !== 0)) {
    console.error(JSON.stringify({ msg: "harness_failed", results }));
    process.exit(1);
  }

  const orm2 = await MikroORM.init({ ...config, debug: false });
  const uow2 = new MikroOrmUnitOfWork(orm2.em.fork());
  await uow2.transactional(async (repos) => {
    const w = await repos.wallets.findById(wallet.id);
    const entries = await repos.ledger.findByWalletId(wallet.id, { limit: 500 });
    const debits = entries.filter((e) => e.direction === "DEBIT");
    const expectedDebits = INSTANCES * BETS_PER_INSTANCE;
    const expectedBalance = (1000 - expectedDebits * 10).toFixed(2);
    console.log(
      JSON.stringify({
        msg: "harness_final",
        balance: w!.balance.toString(),
        expectedBalance,
        debitEntries: debits.length,
        expectedDebits,
        version: w!.version,
      }),
    );
    if (w!.balance.toString() !== expectedBalance || debits.length !== expectedDebits) {
      throw new Error("harness invariant failed");
    }
  });
  await orm2.close(true);
  console.log(JSON.stringify({ msg: "harness_ok" }));
}

main().catch((err) => {
  console.error(JSON.stringify({ msg: "harness_error", error: String(err) }));
  process.exit(1);
});
