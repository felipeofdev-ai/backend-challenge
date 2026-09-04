import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { MikroOrmUnitOfWork } from "../../src/infrastructure/persistence/mikro-orm.unit-of-work";
import { newId } from "../../src/shared/id";
import { SystemClock } from "../../src/wagering/application/ports/repositories";
import { ProcessWagerUseCase } from "../../src/wagering/application/use-cases/process-wager.use-case";
import { assertLedgerReconciliation, postgresAvailable, withOrm } from "../helpers/pg";

const pgAvailable = await postgresAvailable();

describe.skipIf(!pgAvailable)("concurrency · restart recovery", () => {
  test("kill OS child after commit (pre-ack window) → redelivery is idempotent", async () => {
    await withOrm(async ({ createWallet, orm }) => {
      const playerId = newId();
      const wallet = await createWallet.execute({
        playerId,
        initialBalance: { amount: "100.00", currency: "BRL" },
      });
      const externalTransactionId = `rst-${newId()}`;

      const child = spawn(
        process.execPath,
        [
          "run",
          "scripts/restart-recovery-child.ts",
          wallet.id,
          playerId,
          externalTransactionId,
          "8000",
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

      const committed = await new Promise<boolean>((resolve) => {
        const deadline = Date.now() + 20_000;
        const tick = (): void => {
          if (out.includes("committed_before_ack_window")) {
            resolve(true);
            return;
          }
          if (Date.now() > deadline) {
            resolve(false);
            return;
          }
          setTimeout(tick, 50);
        };
        tick();
      });
      expect(committed).toBe(true);

      // Prove commit is durable in PG before kill (cross-process visibility)
      const balRows = (await orm.em
        .getConnection()
        .execute(`SELECT balance::text AS b FROM wallets WHERE id = ?`, [wallet.id])) as Array<{
        b: string;
      }>;
      expect(Number(balRows[0]?.b)).toBe(93);

      child.kill("SIGKILL");
      await new Promise<void>((resolve) => child.on("close", () => resolve()));

      // Fresh UnitOfWork — parent EM must not serve a stale Identity Map
      const clock = new SystemClock();
      const uow = new MikroOrmUnitOfWork(orm.em.fork());
      const processWager = new ProcessWagerUseCase(uow, clock);

      const replay = await processWager.execute({
        providerId: "provider-restart",
        externalTransactionId,
        idempotencyKey: `provider-restart:${externalTransactionId}`,
        playerId,
        walletId: wallet.id,
        roundId: "restart",
        gameId: "g",
        kind: "BET",
        money: { amount: "7.00", currency: "BRL" },
      });
      expect(replay.idempotentReplay).toBe(true);
      expect(replay.balance?.amount).toBe("93.00");

      await uow.transactional(async (repos) => {
        const w = await repos.wallets.findById(wallet.id);
        expect(w!.balance.toString()).toBe("93.00");
        const entries = await repos.ledger.findByWalletId(wallet.id, { limit: 20 });
        expect(entries.filter((e) => e.direction === "DEBIT").length).toBe(1);
      });
      await assertLedgerReconciliation(uow, wallet.id);
    });
  }, 60_000);

  test("unpublished outbox survives restart; second publisher drains it", async () => {
    await withOrm(async ({ createWallet, processWager, orm }) => {
      const playerId = newId();
      const wallet = await createWallet.execute({
        playerId,
        initialBalance: { amount: "200.00", currency: "BRL" },
      });

      await processWager.execute({
        providerId: "provider-ob",
        externalTransactionId: `ob-rst-${newId()}`,
        idempotencyKey: `provider-ob:ob-rst-${newId()}`,
        playerId,
        walletId: wallet.id,
        roundId: "ob-rst",
        gameId: "g",
        kind: "BET",
        money: { amount: "5.00", currency: "BRL" },
      });

      const before = (await orm.em.getConnection().execute(
        `SELECT COUNT(*)::int AS c FROM outbox_messages
         WHERE aggregate_id = ? AND published_at IS NULL`,
        [wallet.id],
      )) as Array<{ c: number }>;
      expect((before[0]?.c ?? 0) > 0).toBe(true);

      // New OS process = restart; drains outbox left by the "dead" API process
      const exitCode = await new Promise<number>((resolve, reject) => {
        const child = spawn(process.execPath, ["run", "scripts/outbox-drain-once.ts", wallet.id], {
          cwd: process.cwd(),
          env: {
            ...process.env,
            DATABASE_PORT: process.env["DATABASE_PORT"] ?? "5433",
            OUTBOX_CLAIM_LEASE_MS: "1000",
          },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let out = "";
        child.stdout.on("data", (d) => {
          out += String(d);
        });
        child.stderr.on("data", (d) => {
          out += String(d);
        });
        child.on("error", reject);
        child.on("close", (code) => {
          if (code !== 0) console.error(out);
          resolve(code ?? 1);
        });
      });
      expect(exitCode).toBe(0);

      const after = (await orm.em.getConnection().execute(
        `SELECT COUNT(*)::int AS c FROM outbox_messages
         WHERE aggregate_id = ? AND published_at IS NULL`,
        [wallet.id],
      )) as Array<{ c: number }>;
      expect(after[0]?.c ?? -1).toBe(0);
    });
  }, 60_000);

  test("inbox redelivery after graceful stop simulation without double debit", async () => {
    await withOrm(async ({ createWallet, uow }) => {
      const clock = new SystemClock();
      const processWager = new ProcessWagerUseCase(uow, clock);
      const playerId = newId();
      const wallet = await createWallet.execute({
        playerId,
        initialBalance: { amount: "50.00", currency: "BRL" },
      });

      const messageId = newId();
      const externalTransactionId = `sig-${newId()}`;
      const body = JSON.stringify({ messageId, kind: "BET" });
      const payloadHash = createHash("sha256").update(body, "utf8").digest("hex");

      const first = await processWager.executeFromQueue(
        {
          providerId: "provider-sig",
          externalTransactionId,
          idempotencyKey: `provider-sig:${externalTransactionId}`,
          playerId,
          walletId: wallet.id,
          roundId: "sig",
          gameId: "g",
          kind: "BET",
          money: { amount: "4.00", currency: "BRL" },
        },
        { consumerName: "wager-consumer", messageId, payloadHash },
      );
      expect(first.kind).toBe("processed");

      const second = await processWager.executeFromQueue(
        {
          providerId: "provider-sig",
          externalTransactionId,
          idempotencyKey: `provider-sig:${externalTransactionId}`,
          playerId,
          walletId: wallet.id,
          roundId: "sig",
          gameId: "g",
          kind: "BET",
          money: { amount: "4.00", currency: "BRL" },
        },
        { consumerName: "wager-consumer", messageId, payloadHash },
      );
      expect(second.kind).toBe("duplicate");

      await uow.transactional(async (repos) => {
        const w = await repos.wallets.findById(wallet.id);
        expect(w!.balance.toString()).toBe("46.00");
      });
      await assertLedgerReconciliation(uow, wallet.id);
    });
  }, 30_000);
});
