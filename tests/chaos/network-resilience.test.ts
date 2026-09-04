import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  SqsMessagingAdapter,
  createSqsClient,
  loadSqsConfigFromEnv,
} from "../../src/infrastructure/sqs/sqs.adapter";
import { newId } from "../../src/shared/id";
import { SystemClock } from "../../src/wagering/application/ports/repositories";
import { ProcessWagerUseCase } from "../../src/wagering/application/use-cases/process-wager.use-case";
import { assertLedgerReconciliation, postgresAvailable, withOrm } from "../helpers/pg";

const pgAvailable = await postgresAvailable();

describe.skipIf(!pgAvailable)("chaos · network resilience (no Toxiproxy required)", () => {
  test("SQS client against unreachable endpoint fails closed", async () => {
    const cfg = loadSqsConfigFromEnv();
    const sqs = new SqsMessagingAdapter(
      createSqsClient({
        ...cfg,
        endpoint: "http://127.0.0.1:1",
        wagerQueueUrl: "http://127.0.0.1:1/000000000000/x.fifo",
        eventsQueueUrl: "http://127.0.0.1:1/000000000000/y.fifo",
      }),
      "http://127.0.0.1:1/000000000000/x.fifo",
      "http://127.0.0.1:1/000000000000/y.fifo",
    );
    const t0 = performance.now();
    expect(await sqs.isReachable()).toBe(false);
    expect(performance.now() - t0).toBeLessThan(15_000);
  });

  test("forced abort mid SQL TX leaves zero partial financial rows", async () => {
    await withOrm(async ({ createWallet, uow, orm }) => {
      const clock = new SystemClock();
      const playerId = newId();
      const wallet = await createWallet.execute({
        playerId,
        initialBalance: { amount: "100.00", currency: "BRL" },
      });

      const before = (await orm.em.getConnection().execute(
        `SELECT
           (SELECT COUNT(*)::int FROM wager_transactions WHERE wallet_id = ?) AS txs,
           (SELECT COUNT(*)::int FROM wallet_ledger_entries WHERE wallet_id = ?) AS ledger,
           (SELECT COUNT(*)::int FROM outbox_messages WHERE aggregate_id = ?) AS outbox,
           (SELECT balance::text FROM wallets WHERE id = ?) AS balance`,
        [wallet.id, wallet.id, wallet.id, wallet.id],
      )) as Array<{ txs: number; ledger: number; outbox: number; balance: string }>;

      const flaky = {
        transactional: async <T>(fn: (repos: never) => Promise<T>): Promise<T> => {
          return uow.transactional(async (repos) => {
            const result = await fn(repos as never);
            // Abort AFTER domain work scheduled in EM, BEFORE commit returns to caller
            throw new Error("injected_network_abort");
          });
        },
      };

      const processWager = new ProcessWagerUseCase(flaky as never, clock);
      const ext = `abort-${newId()}`;
      await expect(
        processWager.execute({
          providerId: "chaos-net",
          externalTransactionId: ext,
          idempotencyKey: `chaos-net:${ext}`,
          playerId,
          walletId: wallet.id,
          roundId: "abort",
          gameId: "g",
          kind: "BET",
          money: { amount: "7.00", currency: "BRL" },
        }),
      ).rejects.toThrow(/injected_network_abort/);

      const after = (await orm.em.getConnection().execute(
        `SELECT
           (SELECT COUNT(*)::int FROM wager_transactions WHERE wallet_id = ?) AS txs,
           (SELECT COUNT(*)::int FROM wallet_ledger_entries WHERE wallet_id = ?) AS ledger,
           (SELECT COUNT(*)::int FROM outbox_messages WHERE aggregate_id = ?) AS outbox,
           (SELECT balance::text FROM wallets WHERE id = ?) AS balance`,
        [wallet.id, wallet.id, wallet.id, wallet.id],
      )) as Array<{ txs: number; ledger: number; outbox: number; balance: string }>;

      expect(after[0]?.txs).toBe(before[0]?.txs);
      expect(after[0]?.ledger).toBe(before[0]?.ledger);
      expect(after[0]?.outbox).toBe(before[0]?.outbox);
      expect(Number(after[0]?.balance)).toBe(100);

      // Prove ledger identity via SQL (avoid Identity Map leftover from aborted TX)
      const recon = (await orm.em.getConnection().execute(
        `SELECT w.balance::text AS stored,
                (COALESCE(SUM(CASE WHEN e.direction = 'CREDIT' THEN e.amount ELSE 0 END),0)
                 - COALESCE(SUM(CASE WHEN e.direction = 'DEBIT' THEN e.amount ELSE 0 END),0))::text AS calculated
         FROM wallets w
         LEFT JOIN wallet_ledger_entries e ON e.wallet_id = w.id
         WHERE w.id = ?
         GROUP BY w.balance`,
        [wallet.id],
      )) as Array<{ stored: string; calculated: string }>;
      expect(recon[0]?.stored).toBe(recon[0]?.calculated);
    });
  }, 30_000);

  test("inbox claim + financial abort rolls back — second delivery processes once", async () => {
    await withOrm(async ({ createWallet, uow }) => {
      const clock = new SystemClock();
      const playerId = newId();
      const wallet = await createWallet.execute({
        playerId,
        initialBalance: { amount: "40.00", currency: "BRL" },
      });
      const messageId = newId();
      const ext = `net-inbox-${newId()}`;
      const payloadHash = createHash("sha256").update(messageId, "utf8").digest("hex");

      const flaky = {
        transactional: async <T>(fn: (repos: never) => Promise<T>): Promise<T> => {
          return uow.transactional(async (repos) => {
            const result = await fn(repos as never);
            throw new Error("broker_disconnect");
          });
        },
      };

      const flakyUc = new ProcessWagerUseCase(flaky as never, clock);
      const input = {
        providerId: "chaos-net",
        externalTransactionId: ext,
        idempotencyKey: `chaos-net:${ext}`,
        playerId,
        walletId: wallet.id,
        roundId: "net",
        gameId: "g",
        kind: "BET" as const,
        money: { amount: "5.00", currency: "BRL" },
      };
      const inbox = { consumerName: "wager-consumer", messageId, payloadHash };

      await expect(flakyUc.executeFromQueue(input, inbox)).rejects.toThrow(/broker_disconnect/);

      const residue = await uow.transactional((repos) =>
        repos.inbox.find("wager-consumer", messageId),
      );
      expect(residue).toBeNull();

      const ok = await new ProcessWagerUseCase(uow, clock).executeFromQueue(input, inbox);
      expect(ok.kind).toBe("processed");

      await uow.transactional(async (repos) => {
        const w = await repos.wallets.findById(wallet.id);
        expect(w!.balance.toString()).toBe("35.00");
        const inboxRow = await repos.inbox.find("wager-consumer", messageId);
        expect(inboxRow?.isProcessed()).toBe(true);
      });
      await assertLedgerReconciliation(uow, wallet.id);
    });
  }, 60_000);
});
