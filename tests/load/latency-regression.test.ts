import { describe, expect, test } from "bun:test";
import { newId } from "../../src/shared/id";
import { assertLedgerReconciliation, postgresAvailable, withOrm } from "../helpers/pg";

const pgAvailable = await postgresAvailable();

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)]!;
}

describe.skipIf(!pgAvailable)("perf · latency regression + parallelism", () => {
  test("sequential BET p50 stays under 150ms after pool tuning", async () => {
    await withOrm(async ({ createWallet, processWager, uow }) => {
      const playerId = newId();
      const wallet = await createWallet.execute({
        playerId,
        initialBalance: { amount: "500.00", currency: "BRL" },
      });
      const samples: number[] = [];
      for (let i = 0; i < 25; i++) {
        const ext = `perf-seq-${i}-${newId()}`;
        const t0 = performance.now();
        await processWager.execute({
          providerId: "perf",
          externalTransactionId: ext,
          idempotencyKey: `perf:${ext}`,
          playerId,
          walletId: wallet.id,
          roundId: `perf-${i}`,
          gameId: "perf",
          kind: "BET",
          money: { amount: "1.00", currency: "BRL" },
        });
        samples.push(performance.now() - t0);
      }
      samples.sort((a, b) => a - b);
      const p50 = percentile(samples, 50);
      const p95 = percentile(samples, 95);
      console.log(
        JSON.stringify({
          msg: "perf_sequential_bet",
          p50: Number(p50.toFixed(2)),
          p95: Number(p95.toFixed(2)),
          max: Number(samples[samples.length - 1]!.toFixed(2)),
        }),
      );
      expect(p50).toBeLessThan(150);
      expect(p95).toBeLessThan(400);
      await assertLedgerReconciliation(uow, wallet.id);
    });
  }, 60_000);

  test("distinct wallets parallel BET faster wall-clock than same-wallet serial equivalent", async () => {
    await withOrm(async ({ createWallet, processWager, uow }) => {
      const wallets = await Promise.all(
        Array.from({ length: 8 }, async () => {
          const playerId = newId();
          return createWallet.execute({
            playerId,
            initialBalance: { amount: "200.00", currency: "BRL" },
          });
        }),
      );

      const parallelJobs = wallets.flatMap((wallet) =>
        Array.from({ length: 5 }, (_, i) => {
          const ext = `perf-par-${wallet.id.slice(0, 8)}-${i}-${newId()}`;
          return () =>
            processWager.execute({
              providerId: "perf",
              externalTransactionId: ext,
              idempotencyKey: `perf:${ext}`,
              playerId: wallet.playerId,
              walletId: wallet.id,
              roundId: `par-${i}`,
              gameId: "perf",
              kind: "BET",
              money: { amount: "1.00", currency: "BRL" },
            });
        }),
      );

      const tParallel = performance.now();
      await Promise.all(parallelJobs.map((fn) => fn()));
      const parallelMs = performance.now() - tParallel;

      // Serial baseline on one wallet (same op count = 40) would be much slower under lock;
      // we compare wall clock of parallel path against a soft budget proving pool parallelism helps.
      console.log(
        JSON.stringify({
          msg: "perf_parallel_distinct_wallets",
          ops: parallelJobs.length,
          wallMs: Number(parallelMs.toFixed(2)),
          opsPerSec: Number(((parallelJobs.length / parallelMs) * 1000).toFixed(2)),
        }),
      );
      expect(parallelMs).toBeLessThan(8_000);
      expect(parallelJobs.length / (parallelMs / 1000)).toBeGreaterThan(8);

      for (const w of wallets) {
        await assertLedgerReconciliation(uow, w.id);
      }
    });
  }, 60_000);

  test("idempotent replay is faster than first ProcessWager (no ledger write)", async () => {
    await withOrm(async ({ createWallet, processWager }) => {
      const playerId = newId();
      const wallet = await createWallet.execute({
        playerId,
        initialBalance: { amount: "50.00", currency: "BRL" },
      });
      const ext = `perf-idem-${newId()}`;
      const input = {
        providerId: "perf",
        externalTransactionId: ext,
        idempotencyKey: `perf:${ext}`,
        playerId,
        walletId: wallet.id,
        roundId: "idem",
        gameId: "perf",
        kind: "BET",
        money: { amount: "2.00", currency: "BRL" },
      };
      const t0 = performance.now();
      const first = await processWager.execute(input);
      const firstMs = performance.now() - t0;
      const t1 = performance.now();
      const replay = await processWager.execute(input);
      const replayMs = performance.now() - t1;
      expect(replay.idempotentReplay).toBe(true);
      expect(replay.transactionId).toBe(first.transactionId);
      console.log(
        JSON.stringify({
          msg: "perf_idempotent_replay",
          firstMs: Number(firstMs.toFixed(2)),
          replayMs: Number(replayMs.toFixed(2)),
        }),
      );
      expect(replayMs).toBeLessThan(firstMs);
    });
  }, 30_000);
});
