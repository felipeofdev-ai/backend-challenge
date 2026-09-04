/**
 * Full-system timing & atomicity report for Jungle Gaming evaluation.
 *
 * Runs against real PostgreSQL and emits JSON + human summary:
 *   bun run scripts/system-report.ts
 *   REPORT_OUT=docs/SYSTEM_REPORT.json bun run report:system
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { MikroORM } from "@mikro-orm/postgresql";
import config from "../mikro-orm.config";
import { MikroOrmUnitOfWork } from "../src/infrastructure/persistence/mikro-orm.unit-of-work";
import { wagerSloLatencyUnder250msRatio } from "../src/infrastructure/observability/metrics";
import { newId } from "../src/shared/id";
import { SystemClock } from "../src/wagering/application/ports/repositories";
import { CreateWalletUseCase } from "../src/wagering/application/use-cases/create-wallet.use-case";
import { ProcessWagerUseCase } from "../src/wagering/application/use-cases/process-wager.use-case";
import { ReconcileWalletUseCase } from "../src/wagering/application/use-cases/reconcile-wallet.use-case";
import { WagerTransactionStatus } from "../src/wagering/domain";

process.env["DATABASE_PORT"] = process.env["DATABASE_PORT"] ?? "5433";

type Timing = { name: string; samplesMs: number[]; ok: number; fail: number };

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return Number(sorted[Math.max(0, idx)]!.toFixed(2));
}

function summarize(t: Timing) {
  const sorted = [...t.samplesMs].sort((a, b) => a - b);
  return {
    name: t.name,
    count: t.samplesMs.length,
    ok: t.ok,
    fail: t.fail,
    latencyMs: {
      min: sorted[0] !== undefined ? Number(sorted[0].toFixed(2)) : 0,
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
      p99: percentile(sorted, 99),
      max: sorted.length ? Number(sorted[sorted.length - 1]!.toFixed(2)) : 0,
      mean: sorted.length
        ? Number((sorted.reduce((a, b) => a + b, 0) / sorted.length).toFixed(2))
        : 0,
    },
  };
}

async function timed<T>(
  timing: Timing,
  fn: () => Promise<T>,
): Promise<T> {
  const t0 = performance.now();
  try {
    const result = await fn();
    timing.samplesMs.push(performance.now() - t0);
    timing.ok += 1;
    return result;
  } catch (err) {
    timing.samplesMs.push(performance.now() - t0);
    timing.fail += 1;
    throw err;
  }
}

async function main(): Promise<void> {
  const wallStart = Date.now();
  const orm = await MikroORM.init({ ...config, debug: false });
  const uow = new MikroOrmUnitOfWork(orm.em.fork());
  const clock = new SystemClock();
  const createWallet = new CreateWalletUseCase(uow, clock);
  const processWager = new ProcessWagerUseCase(uow, clock);
  const reconcile = new ReconcileWalletUseCase(uow, clock);

  const betT: Timing = { name: "BET", samplesMs: [], ok: 0, fail: 0 };
  const winT: Timing = { name: "WIN", samplesMs: [], ok: 0, fail: 0 };
  const refundT: Timing = { name: "REFUND", samplesMs: [], ok: 0, fail: 0 };
  const concurrentT: Timing = { name: "CONCURRENT_BET", samplesMs: [], ok: 0, fail: 0 };
  const idemT: Timing = { name: "IDEMPOTENT_REPLAY", samplesMs: [], ok: 0, fail: 0 };
  const reconT: Timing = { name: "RECONCILIATION", samplesMs: [], ok: 0, fail: 0 };

  const playerId = newId();
  const wallet = await createWallet.execute({
    playerId,
    initialBalance: { amount: "1000.00", currency: "BRL" },
  });

  // Sequential lifecycle: BET → WIN → REFUND on another BET
  for (let i = 0; i < 20; i++) {
    const betExt = `sr-bet-${i}-${newId()}`;
    await timed(betT, () =>
      processWager.execute({
        providerId: "system-report",
        externalTransactionId: betExt,
        idempotencyKey: `sr:${betExt}`,
        playerId,
        walletId: wallet.id,
        roundId: `sr-r-${i}`,
        gameId: "sr",
        kind: "BET",
        money: { amount: "5.00", currency: "BRL" },
      }),
    );

    const winExt = `sr-win-${i}-${newId()}`;
    await timed(winT, () =>
      processWager.execute({
        providerId: "system-report",
        externalTransactionId: winExt,
        idempotencyKey: `sr:${winExt}`,
        playerId,
        walletId: wallet.id,
        roundId: `sr-r-${i}`,
        gameId: "sr",
        kind: "WIN",
        money: { amount: "8.00", currency: "BRL" },
        referenceExternalTransactionId: betExt,
      }),
    );
  }

  // Dedicated BET + REFUND pairs
  for (let i = 0; i < 10; i++) {
    const betExt = `sr-rf-bet-${i}-${newId()}`;
    await processWager.execute({
      providerId: "system-report",
      externalTransactionId: betExt,
      idempotencyKey: `sr:${betExt}`,
      playerId,
      walletId: wallet.id,
      roundId: `sr-rf-${i}`,
      gameId: "sr",
      kind: "BET",
      money: { amount: "3.00", currency: "BRL" },
    });
    const refundExt = `sr-rf-${i}-${newId()}`;
    await timed(refundT, () =>
      processWager.execute({
        providerId: "system-report",
        externalTransactionId: refundExt,
        idempotencyKey: `sr:${refundExt}`,
        playerId,
        walletId: wallet.id,
        roundId: `sr-rf-${i}`,
        gameId: "sr",
        kind: "REFUND",
        money: { amount: "3.00", currency: "BRL" },
        referenceExternalTransactionId: betExt,
      }),
    );
  }

  // Concurrent BETs on same wallet (lock contention)
  const concJobs = Array.from({ length: 40 }, (_, i) => {
    const ext = `sr-conc-${i}-${newId()}`;
    return timed(concurrentT, () =>
      processWager.execute({
        providerId: "system-report",
        externalTransactionId: ext,
        idempotencyKey: `sr:${ext}`,
        playerId,
        walletId: wallet.id,
        roundId: `sr-conc-${i}`,
        gameId: "sr",
        kind: "BET",
        money: { amount: "1.00", currency: "BRL" },
      }),
    );
  });
  await Promise.all(concJobs);

  // Idempotent replay
  const idemExt = `sr-idem-${newId()}`;
  const first = await processWager.execute({
    providerId: "system-report",
    externalTransactionId: idemExt,
    idempotencyKey: `sr:${idemExt}`,
    playerId,
    walletId: wallet.id,
    roundId: "sr-idem",
    gameId: "sr",
    kind: "BET",
    money: { amount: "2.00", currency: "BRL" },
  });
  const replay = await timed(idemT, () =>
    processWager.execute({
      providerId: "system-report",
      externalTransactionId: idemExt,
      idempotencyKey: `sr:${idemExt}`,
      playerId,
      walletId: wallet.id,
      roundId: "sr-idem",
      gameId: "sr",
      kind: "BET",
      money: { amount: "2.00", currency: "BRL" },
    }),
  );
  const idempotentOk =
    replay.idempotentReplay === true &&
    replay.transactionId === first.transactionId &&
    replay.status === WagerTransactionStatus.Processed;

  const recon = await timed(reconT, () => reconcile.execute(wallet.id));

  const outboxLag = (await orm.em.getConnection().execute(
    `SELECT COUNT(*)::int AS c FROM outbox_messages
     WHERE aggregate_id = ? AND published_at IS NULL`,
    [wallet.id],
  )) as Array<{ c: number }>;

  const allLatencies = [
    ...betT.samplesMs,
    ...winT.samplesMs,
    ...refundT.samplesMs,
    ...concurrentT.samplesMs,
  ].sort((a, b) => a - b);
  const under250 = allLatencies.filter((ms) => ms < 250).length;
  const sloRatio = allLatencies.length ? under250 / allLatencies.length : 0;
  wagerSloLatencyUnder250msRatio.set(sloRatio);

  const scenarios = [
    summarize(betT),
    summarize(winT),
    summarize(refundT),
    summarize(concurrentT),
    summarize(idemT),
    summarize(reconT),
  ];

  const report = {
    generatedAt: new Date().toISOString(),
    wallClockMs: Date.now() - wallStart,
    walletId: wallet.id,
    atomicity: {
      reconciliationConsistent: recon.consistent,
      idempotentReplay: idempotentOk,
      outboxLagMessages: Number(outboxLag[0]?.c ?? 0),
      invariants: [
        "Money via decimal.js — no float",
        "SELECT FOR UPDATE per walletId",
        "ledger immutable (DB trigger)",
        "outbox same SQL TX as financial effect",
        "inbox claim+process same TX (executeFromQueue)",
        "ack SQS only after commit",
      ],
    },
    slo: {
      targetLatencyMs: 250,
      under250msRatio: Number(sloRatio.toFixed(4)),
      sampleSize: allLatencies.length,
    },
    scenarios,
    alignment: {
      challenge: "junglegaming/backend-challenge",
      auth: "AUTH_MODE=static (eval) | AUTH_MODE=oidc + Keycloak profile=auth",
      messaging: "LocalStack SQS FIFO + DLQ; DB is source of truth",
      observability: "pino + Prometheus + OTel API spans + /docs Swagger",
    },
  };

  const outPath = resolve(
    process.env["REPORT_OUT"] ?? "docs/SYSTEM_REPORT.json",
  );
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  const mdPath = outPath.replace(/\.json$/i, ".md");
  const lines = [
    "# System report — wagering-processor",
    "",
    `Generated: ${report.generatedAt}`,
    `Wall clock: ${report.wallClockMs} ms`,
    "",
    "## Atomicity",
    "",
    `- Reconciliation consistent: **${recon.consistent}**`,
    `- Idempotent replay: **${idempotentOk}**`,
    `- Outbox lag (unpublished): **${report.atomicity.outboxLagMessages}**`,
    "",
    "## Latency by scenario (ms)",
    "",
    "| Scenario | n | ok | p50 | p95 | p99 | max | mean |",
    "|---|---:|---:|---:|---:|---:|---:|---:|",
    ...scenarios.map(
      (s) =>
        `| ${s.name} | ${s.count} | ${s.ok} | ${s.latencyMs.p50} | ${s.latencyMs.p95} | ${s.latencyMs.p99} | ${s.latencyMs.max} | ${s.latencyMs.mean} |`,
    ),
    "",
    `## SLO (<250ms): ${(sloRatio * 100).toFixed(1)}% of ${allLatencies.length} samples`,
    "",
  ];
  writeFileSync(mdPath, `${lines.join("\n")}\n`, "utf8");

  console.log(JSON.stringify(report, null, 2));
  console.log(`\nWrote ${outPath}`);
  console.log(`Wrote ${mdPath}`);

  if (!recon.consistent || !idempotentOk) {
    process.exitCode = 1;
  }

  await orm.close(true);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
