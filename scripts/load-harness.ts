/**
 * Phase 10 load harness — sustained parallel BETs against real PostgreSQL.
 * Reports throughput + latency percentiles + outbox lag; asserts ledger invariant.
 *
 * Usage:
 *   bun run scripts/load-harness.ts
 * Env:
 *   LOAD_WALLETS=8 LOAD_BETS_PER_WALLET=40 LOAD_AMOUNT=1.00 LOAD_CONCURRENCY=32
 */
import { MikroORM } from "@mikro-orm/postgresql";
import config from "../mikro-orm.config";
import { MikroOrmUnitOfWork } from "../src/infrastructure/persistence/mikro-orm.unit-of-work";
import { newId } from "../src/shared/id";
import { SystemClock } from "../src/wagering/application/ports/repositories";
import { CreateWalletUseCase } from "../src/wagering/application/use-cases/create-wallet.use-case";
import { ProcessWagerUseCase } from "../src/wagering/application/use-cases/process-wager.use-case";
import { ReconcileWalletUseCase } from "../src/wagering/application/use-cases/reconcile-wallet.use-case";
import { WagerTransactionStatus } from "../src/wagering/domain";
import { Money } from "../src/wagering/domain/value-objects/money";

process.env["DATABASE_PORT"] = process.env["DATABASE_PORT"] ?? "5433";

const WALLETS = Number(process.env["LOAD_WALLETS"] ?? 8);
const BETS = Number(process.env["LOAD_BETS_PER_WALLET"] ?? 40);
const AMOUNT = process.env["LOAD_AMOUNT"] ?? "1.00";
const CONCURRENCY = Number(process.env["LOAD_CONCURRENCY"] ?? 32);

function percentile(sortedMs: number[], p: number): number {
  if (sortedMs.length === 0) return 0;
  const idx = Math.min(sortedMs.length - 1, Math.ceil((p / 100) * sortedMs.length) - 1);
  return sortedMs[Math.max(0, idx)]!;
}

async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!, i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

async function main(): Promise<void> {
  const started = Date.now();
  const orm = await MikroORM.init({ ...config, debug: false });
  const uow = new MikroOrmUnitOfWork(orm.em.fork());
  const clock = new SystemClock();
  const createWallet = new CreateWalletUseCase(uow, clock);
  const processWager = new ProcessWagerUseCase(uow, clock);
  const reconcile = new ReconcileWalletUseCase(uow, clock);

  const initial = Money.from({ amount: "10000.00", currency: "BRL" });
  const wallets = await Promise.all(
    Array.from({ length: WALLETS }, async () => {
      const playerId = newId();
      return createWallet.execute({
        playerId,
        initialBalance: initial.toJSON(),
      });
    }),
  );

  const jobs = wallets.flatMap((wallet) =>
    Array.from({ length: BETS }, (_, i) => ({
      wallet,
      i,
      externalTransactionId: `load-${wallet.id.slice(0, 8)}-${i}-${newId()}`,
    })),
  );

  const results = await mapPool(jobs, CONCURRENCY, async (job) => {
    const t0 = performance.now();
    const r = await processWager.execute({
      providerId: "load",
      externalTransactionId: job.externalTransactionId,
      idempotencyKey: `load:${job.externalTransactionId}`,
      playerId: job.wallet.playerId,
      walletId: job.wallet.id,
      roundId: `load-${job.i}`,
      gameId: "load",
      kind: "BET",
      money: { amount: AMOUNT, currency: "BRL" },
    });
    return { status: r.status, latencyMs: performance.now() - t0 };
  });

  const latencies = results.map((r) => r.latencyMs).sort((a, b) => a - b);
  const processed = results.filter((r) => r.status === WagerTransactionStatus.Processed).length;
  const rejected = results.filter((r) => r.status === WagerTransactionStatus.Rejected).length;
  const expectedDebit = Money.from({ amount: AMOUNT, currency: "BRL" });
  let ok = 0;
  let bad = 0;

  for (const wallet of wallets) {
    const rec = await reconcile.execute(wallet.id);
    if (!rec.consistent) {
      bad += 1;
      console.error(JSON.stringify({ msg: "load_divergence", ...rec }));
      continue;
    }
    let totalDebit = Money.zero("BRL");
    for (let i = 0; i < BETS; i++) totalDebit = totalDebit.add(expectedDebit);
    const expectedExact = initial.subtract(totalDebit).toString();
    if (rec.storedBalance.amount !== expectedExact) {
      bad += 1;
      console.error(
        JSON.stringify({
          msg: "load_balance_mismatch",
          walletId: wallet.id,
          stored: rec.storedBalance.amount,
          expected: expectedExact,
        }),
      );
      continue;
    }
    ok += 1;
  }

  const walletIds = wallets.map((w) => w.id);
  const placeholders = walletIds.map(() => "?").join(", ");
  const lagRows = (await orm.em.getConnection().execute(
    `SELECT COUNT(*)::int AS c FROM outbox_messages
     WHERE published_at IS NULL AND aggregate_id IN (${placeholders})`,
    walletIds,
  )) as Array<{ c: number }>;
  const outboxLag = lagRows[0]?.c ?? 0;

  const elapsedMs = Date.now() - started;
  const report = {
    msg: "load_harness_done",
    wallets: WALLETS,
    betsPerWallet: BETS,
    totalOps: jobs.length,
    concurrency: CONCURRENCY,
    processed,
    rejected,
    walletsOk: ok,
    walletsBad: bad,
    elapsedMs,
    opsPerSec: Number((jobs.length / (elapsedMs / 1000)).toFixed(2)),
    latencyMs: {
      p50: Number(percentile(latencies, 50).toFixed(2)),
      p95: Number(percentile(latencies, 95).toFixed(2)),
      p99: Number(percentile(latencies, 99).toFixed(2)),
      max: Number((latencies.at(-1) ?? 0).toFixed(2)),
    },
    outboxLagMessages: outboxLag,
  };
  console.log(JSON.stringify(report));
  await orm.close(true);
  if (bad > 0 || processed !== jobs.length) process.exit(1);
}

main().catch((err) => {
  console.error(JSON.stringify({ msg: "load_harness_error", error: String(err) }));
  process.exit(1);
});
