import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { newId } from "../../src/shared/id";
import { WagerTransactionStatus } from "../../src/wagering/domain";
import { assertLedgerReconciliation, postgresAvailable, withOrm } from "../helpers/pg";

const pgAvailable = await postgresAvailable();

function percentile(sortedMs: number[], p: number): number {
  if (sortedMs.length === 0) return 0;
  const idx = Math.min(sortedMs.length - 1, Math.ceil((p / 100) * sortedMs.length) - 1);
  return sortedMs[Math.max(0, idx)]!;
}

describe.skipIf(!pgAvailable)("load · sustained throughput against PostgreSQL", () => {
  test("200 distinct BETs across 4 wallets under pool concurrency", async () => {
    await withOrm(async ({ createWallet, processWager, uow }) => {
      const wallets = await Promise.all(
        Array.from({ length: 4 }, async () => {
          const playerId = newId();
          return createWallet.execute({
            playerId,
            initialBalance: { amount: "1000.00", currency: "BRL" },
          });
        }),
      );

      const jobs = wallets.flatMap((wallet) =>
        Array.from({ length: 50 }, (_, i) => ({ wallet, i })),
      );

      const started = Date.now();
      const timed = await Promise.all(
        jobs.map(async (job) => {
          const ext = `ld-${job.wallet.id.slice(0, 8)}-${job.i}-${newId()}`;
          const t0 = performance.now();
          const result = await processWager.execute({
            providerId: "load",
            externalTransactionId: ext,
            idempotencyKey: `load:${ext}`,
            playerId: job.wallet.playerId,
            walletId: job.wallet.id,
            roundId: `ld-${job.i}`,
            gameId: "load",
            kind: "BET",
            money: { amount: "2.00", currency: "BRL" },
          });
          return { result, latencyMs: performance.now() - t0 };
        }),
      );
      const elapsedMs = Date.now() - started;
      const latencies = timed.map((t) => t.latencyMs).sort((a, b) => a - b);

      expect(timed.every((t) => t.result.status === WagerTransactionStatus.Processed)).toBe(true);
      for (const wallet of wallets) {
        await uow.transactional(async (repos) => {
          const w = await repos.wallets.findById(wallet.id);
          expect(w!.balance.toString()).toBe("900.00");
        });
        await assertLedgerReconciliation(uow, wallet.id);
      }

      expect(elapsedMs).toBeLessThan(120_000);
      // eslint-disable-next-line no-console
      console.log(
        JSON.stringify({
          msg: "load_test_stats",
          ops: timed.length,
          elapsedMs,
          opsPerSec: Number((timed.length / (elapsedMs / 1000)).toFixed(2)),
          latencyMs: {
            p50: Number(percentile(latencies, 50).toFixed(2)),
            p95: Number(percentile(latencies, 95).toFixed(2)),
            p99: Number(percentile(latencies, 99).toFixed(2)),
            max: Number((latencies.at(-1) ?? 0).toFixed(2)),
          },
        }),
      );
    });
  }, 120_000);

  test("standalone load-harness script exits 0 and reports percentiles", async () => {
    let out = "";
    const exitCode = await new Promise<number>((resolve, reject) => {
      const child = spawn(process.execPath, ["run", "scripts/load-harness.ts"], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          DATABASE_PORT: process.env["DATABASE_PORT"] ?? "5433",
          LOAD_WALLETS: "4",
          LOAD_BETS_PER_WALLET: "25",
          LOAD_AMOUNT: "1.00",
          LOAD_CONCURRENCY: "16",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout.on("data", (d) => {
        out += String(d);
      });
      child.stderr.on("data", (d) => {
        out += String(d);
      });
      child.on("error", reject);
      child.on("close", (code) => resolve(code ?? 1));
    });
    if (exitCode !== 0) console.error(out);
    expect(exitCode).toBe(0);
    const line = out.trim().split("\n").at(-1) ?? "";
    // eslint-disable-next-line no-console
    console.log(line);
    const report = JSON.parse(line) as {
      latencyMs?: { p50: number; p95: number; p99: number };
      outboxLagMessages?: number;
    };
    expect(report.latencyMs?.p50).toBeGreaterThan(0);
    expect(report.latencyMs?.p99).toBeGreaterThanOrEqual(report.latencyMs?.p50 ?? 0);
    expect(typeof report.outboxLagMessages).toBe("number");
  }, 180_000);
});
