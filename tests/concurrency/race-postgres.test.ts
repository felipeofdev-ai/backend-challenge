import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { MikroOrmUnitOfWork } from "../../src/infrastructure/persistence/mikro-orm.unit-of-work";
import { OutboxPublisher } from "../../src/infrastructure/sqs/outbox-publisher";
import { newId } from "../../src/shared/id";
import { SystemClock } from "../../src/wagering/application/ports/repositories";
import { ReconcileWalletUseCase } from "../../src/wagering/application/use-cases/reconcile-wallet.use-case";
import { FailureCode, WagerTransactionStatus } from "../../src/wagering/domain";
import { assertLedgerReconciliation, postgresAvailable, withOrm } from "../helpers/pg";

const pgAvailable = await postgresAvailable();

describe.skipIf(!pgAvailable)("concurrency against real PostgreSQL", () => {
  test("§8 two concurrent 80 BETs on 100 → 1 PROCESSED, 1 REJECTED, balance 20", async () => {
    await withOrm(async ({ createWallet, processWager, uow }) => {
      const playerId = newId();
      const wallet = await createWallet.execute({
        playerId,
        initialBalance: { amount: "100.00", currency: "BRL" },
      });

      const [a, b] = await Promise.all([
        processWager.execute({
          providerId: "provider-a",
          externalTransactionId: `bet-a-${newId()}`,
          idempotencyKey: `provider-a:race-a-${newId()}`,
          playerId,
          walletId: wallet.id,
          roundId: "race",
          gameId: "g",
          kind: "BET",
          money: { amount: "80.00", currency: "BRL" },
        }),
        processWager.execute({
          providerId: "provider-a",
          externalTransactionId: `bet-b-${newId()}`,
          idempotencyKey: `provider-a:race-b-${newId()}`,
          playerId,
          walletId: wallet.id,
          roundId: "race",
          gameId: "g",
          kind: "BET",
          money: { amount: "80.00", currency: "BRL" },
        }),
      ]);

      const statuses = [a.status, b.status].sort();
      expect(statuses).toEqual([WagerTransactionStatus.Processed, WagerTransactionStatus.Rejected]);
      const rejected = a.status === WagerTransactionStatus.Rejected ? a : b;
      expect(rejected.failureCode).toBe(FailureCode.INSUFFICIENT_BALANCE);

      await uow.transactional(async (repos) => {
        const w = await repos.wallets.findById(wallet.id);
        expect(w!.balance.toString()).toBe("20.00");
        const entries = await repos.ledger.findByWalletId(wallet.id, { limit: 100 });
        const debits = entries.filter((e) => e.direction === "DEBIT");
        expect(debits.length).toBe(1);
      });
      await assertLedgerReconciliation(uow, wallet.id);
    });
  }, 60_000);

  test("same bet 50× in parallel → single debit + replays", async () => {
    await withOrm(async ({ createWallet, processWager, uow }) => {
      const playerId = newId();
      const wallet = await createWallet.execute({
        playerId,
        initialBalance: { amount: "500.00", currency: "BRL" },
      });
      const externalTransactionId = `same-${newId()}`;
      const idempotencyKey = `provider-a:${externalTransactionId}`;
      const input = {
        providerId: "provider-a",
        externalTransactionId,
        idempotencyKey,
        playerId,
        walletId: wallet.id,
        roundId: "same",
        gameId: "g",
        kind: "BET",
        money: { amount: "25.00", currency: "BRL" },
      };

      const results = await Promise.all(
        Array.from({ length: 50 }, () => processWager.execute(input)),
      );

      const processed = results.filter((r) => r.status === WagerTransactionStatus.Processed);
      expect(processed.length).toBe(50);
      expect(results.filter((r) => !r.idempotentReplay).length).toBe(1);
      expect(results.filter((r) => r.idempotentReplay).length).toBe(49);
      expect(new Set(results.map((r) => r.transactionId)).size).toBe(1);

      await uow.transactional(async (repos) => {
        const w = await repos.wallets.findById(wallet.id);
        expect(w!.balance.toString()).toBe("475.00");
        const entries = await repos.ledger.findByWalletId(wallet.id, { limit: 100 });
        expect(entries.filter((e) => e.direction === "DEBIT").length).toBe(1);
      });
      await assertLedgerReconciliation(uow, wallet.id);
    });
  }, 60_000);

  test("distinct wallets process in parallel without interference", async () => {
    await withOrm(async ({ createWallet, processWager, uow }) => {
      const wallets = await Promise.all(
        Array.from({ length: 8 }, async () => {
          const playerId = newId();
          return createWallet.execute({
            playerId,
            initialBalance: { amount: "100.00", currency: "BRL" },
          });
        }),
      );

      await Promise.all(
        wallets.map((wallet, i) =>
          processWager.execute({
            providerId: "provider-a",
            externalTransactionId: `pw-${i}-${newId()}`,
            idempotencyKey: `provider-a:pw-${i}-${newId()}`,
            playerId: wallet.playerId,
            walletId: wallet.id,
            roundId: `r-${i}`,
            gameId: "g",
            kind: "BET",
            money: { amount: "10.00", currency: "BRL" },
          }),
        ),
      );

      for (const wallet of wallets) {
        await uow.transactional(async (repos) => {
          const w = await repos.wallets.findById(wallet.id);
          expect(w!.balance.toString()).toBe("90.00");
        });
        await assertLedgerReconciliation(uow, wallet.id);
      }
    });
  }, 60_000);

  test("crash-after-commit: redelivery is idempotent (no double debit)", async () => {
    await withOrm(async ({ createWallet, processWager, uow }) => {
      const playerId = newId();
      const wallet = await createWallet.execute({
        playerId,
        initialBalance: { amount: "100.00", currency: "BRL" },
      });
      const externalTransactionId = `crash-${newId()}`;
      const input = {
        providerId: "provider-a",
        externalTransactionId,
        idempotencyKey: `provider-a:${externalTransactionId}`,
        playerId,
        walletId: wallet.id,
        roundId: "crash",
        gameId: "g",
        kind: "BET",
        money: { amount: "15.00", currency: "BRL" },
      };

      const first = await processWager.execute(input);
      expect(first.idempotentReplay).toBe(false);
      // Simulate crash after commit before ack → broker redelivers same business payload
      const second = await processWager.execute(input);
      expect(second.idempotentReplay).toBe(true);
      expect(second.transactionId).toBe(first.transactionId);
      expect(second.balance?.amount).toBe("85.00");

      await uow.transactional(async (repos) => {
        const w = await repos.wallets.findById(wallet.id);
        expect(w!.balance.toString()).toBe("85.00");
        const entries = await repos.ledger.findByWalletId(wallet.id, { limit: 50 });
        expect(entries.filter((e) => e.direction === "DEBIT").length).toBe(1);
      });
      await assertLedgerReconciliation(uow, wallet.id);
    });
  }, 30_000);

  test("two concurrent outbox publishers partition via SKIP LOCKED", async () => {
    await withOrm(async ({ createWallet, processWager, orm }) => {
      const prevLease = process.env["OUTBOX_CLAIM_LEASE_MS"];
      process.env["OUTBOX_CLAIM_LEASE_MS"] = "100";
      try {
        const playerId = newId();
        const wallet = await createWallet.execute({
          playerId,
          initialBalance: { amount: "500.00", currency: "BRL" },
        });

        for (let i = 0; i < 12; i++) {
          await processWager.execute({
            providerId: "provider-a",
            externalTransactionId: `ob-${i}-${newId()}`,
            idempotencyKey: `provider-a:ob-${i}-${newId()}`,
            playerId,
            walletId: wallet.id,
            roundId: "ob",
            gameId: "g",
            kind: "BET",
            money: { amount: "1.00", currency: "BRL" },
          });
        }

        // Isolate this wallet's due set — shared DB accumulates unpublished outbox from prior suites
        await orm.em.getConnection().execute(
          `UPDATE outbox_messages
           SET next_attempt_at = NOW() + INTERVAL '1 day'
           WHERE published_at IS NULL AND aggregate_id <> ?`,
          [wallet.id],
        );
        await orm.em.getConnection().execute(
          `UPDATE outbox_messages
           SET next_attempt_at = NOW() - INTERVAL '1 second'
           WHERE published_at IS NULL AND aggregate_id = ?`,
          [wallet.id],
        );

        const fakeSqs = {
          publishEvent: async () => undefined,
        };

        const clock = new SystemClock();
        // Separate EM forks — concurrent transactional() on one EntityManager is unsafe
        const p1 = new OutboxPublisher(
          new MikroOrmUnitOfWork(orm.em.fork()),
          fakeSqs as never,
          clock,
          60_000,
        );
        const p2 = new OutboxPublisher(
          new MikroOrmUnitOfWork(orm.em.fork()),
          fakeSqs as never,
          clock,
          60_000,
        );

        const [n1, n2] = await Promise.all([p1.publishBatch(50), p2.publishBatch(50)]);
        expect(n1 + n2).toBeGreaterThanOrEqual(12);

        // Drain stragglers after short leases expire
        for (let attempt = 0; attempt < 10; attempt++) {
          await orm.em.getConnection().execute(
            `UPDATE outbox_messages
             SET next_attempt_at = NOW() - INTERVAL '1 second'
             WHERE published_at IS NULL AND aggregate_id = ?`,
            [wallet.id],
          );
          await p1.publishBatch(50);
          await p2.publishBatch(50);
          const rows = (await orm.em.getConnection().execute(
            `SELECT COUNT(*)::int AS c FROM outbox_messages
             WHERE aggregate_id = ? AND published_at IS NULL`,
            [wallet.id],
          )) as Array<{ c: number }>;
          if ((rows[0]?.c ?? -1) === 0) break;
          await Bun.sleep(120);
        }

        const finalRows = (await orm.em.getConnection().execute(
          `SELECT COUNT(*)::int AS c FROM outbox_messages
           WHERE aggregate_id = ? AND published_at IS NULL`,
          [wallet.id],
        )) as Array<{ c: number }>;
        expect(finalRows[0]?.c ?? -1).toBe(0);
      } finally {
        if (prevLease !== undefined) process.env["OUTBOX_CLAIM_LEASE_MS"] = prevLease;
        else Reflect.deleteProperty(process.env, "OUTBOX_CLAIM_LEASE_MS");
      }
    });
  }, 60_000);

  test("reconciliation endpoint use-case matches ledger", async () => {
    await withOrm(async ({ createWallet, processWager, uow }) => {
      const clock = new SystemClock();
      const reconcile = new ReconcileWalletUseCase(uow, clock);
      const playerId = newId();
      const wallet = await createWallet.execute({
        playerId,
        initialBalance: { amount: "50.00", currency: "BRL" },
      });
      await processWager.execute({
        providerId: "provider-a",
        externalTransactionId: `rec-${newId()}`,
        idempotencyKey: `provider-a:rec-${newId()}`,
        playerId,
        walletId: wallet.id,
        roundId: "rec",
        gameId: "g",
        kind: "BET",
        money: { amount: "12.50", currency: "BRL" },
      });

      const result = await reconcile.execute(wallet.id);
      expect(result.consistent).toBe(true);
      expect(result.storedBalance.amount).toBe("37.50");
      expect(result.calculatedBalance.amount).toBe("37.50");
      expect(result.difference.amount).toBe("0.00");
    });
  }, 30_000);

  test("≥3 OS processes share one wallet without double debit", async () => {
    const exitCode = await new Promise<number>((resolve, reject) => {
      const child = spawn(process.execPath, ["run", "scripts/concurrency-harness.ts"], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          DATABASE_PORT: process.env["DATABASE_PORT"] ?? "5433",
          CONCURRENCY_INSTANCES: "3",
          CONCURRENCY_BETS: "4",
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
        if (code !== 0) {
          // eslint-disable-next-line no-console
          console.error(out);
        }
        resolve(code ?? 1);
      });
    });
    expect(exitCode).toBe(0);
  }, 120_000);
});
