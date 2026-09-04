import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  SqsMessagingAdapter,
  createSqsClient,
  loadSqsConfigFromEnv,
} from "../../src/infrastructure/sqs/sqs.adapter";
import { InboxMessage } from "../../src/messaging/domain/inbox-message";
import { newId } from "../../src/shared/id";
import { SystemClock } from "../../src/wagering/application/ports/repositories";
import { ProcessWagerUseCase } from "../../src/wagering/application/use-cases/process-wager.use-case";
import { assertLedgerReconciliation, postgresAvailable, withOrm } from "../helpers/pg";

const pgAvailable = await postgresAvailable();

describe.skipIf(!pgAvailable)("chaos · resilience & atomicity", () => {
  test("SQS probe fails closed when endpoint is unreachable", async () => {
    const cfg = loadSqsConfigFromEnv();
    const sqs = new SqsMessagingAdapter(
      createSqsClient({
        ...cfg,
        endpoint: "http://127.0.0.1:1",
        wagerQueueUrl: "http://127.0.0.1:1/000000000000/missing.fifo",
        eventsQueueUrl: "http://127.0.0.1:1/000000000000/missing-events.fifo",
      }),
      "http://127.0.0.1:1/000000000000/missing.fifo",
      "http://127.0.0.1:1/000000000000/missing-events.fifo",
    );
    expect(await sqs.isReachable()).toBe(false);
  });

  test("inbox claim rolls back with financial TX — redelivery processes once", async () => {
    await withOrm(async ({ createWallet, uow, orm }) => {
      const clock = new SystemClock();
      const processWager = new ProcessWagerUseCase(uow, clock);
      const playerId = newId();
      const wallet = await createWallet.execute({
        playerId,
        initialBalance: { amount: "80.00", currency: "BRL" },
      });

      const messageId = newId();
      const externalTransactionId = `chaos-${newId()}`;
      const payloadHash = createHash("sha256").update(messageId, "utf8").digest("hex");
      const inbox = { consumerName: "wager-consumer", messageId, payloadHash };
      const input = {
        providerId: "chaos",
        externalTransactionId,
        idempotencyKey: `chaos:${externalTransactionId}`,
        playerId,
        walletId: wallet.id,
        roundId: "chaos",
        gameId: "g",
        kind: "BET" as const,
        money: { amount: "8.00", currency: "BRL" },
      };

      // Real proof: claim + financial work complete inside UoW, then abort before commit
      const flaky = {
        transactional: async <T>(fn: (repos: never) => Promise<T>): Promise<T> => {
          return uow.transactional(async (repos) => {
            const result = await fn(repos as never);
            throw new Error("simulated_crash_after_financial_effects");
          });
        },
      };

      await expect(
        new ProcessWagerUseCase(flaky as never, clock).executeFromQueue(input, inbox),
      ).rejects.toThrow(/simulated_crash_after_financial_effects/);

      // Bypass Identity Map — assert durable state via SQL on a fresh connection
      const residue = (await orm.em.fork().execute(
        `SELECT
           (SELECT COUNT(*)::int FROM inbox_messages WHERE consumer_name = ? AND message_id = ?) AS inbox,
           (SELECT balance::text FROM wallets WHERE id = ?) AS balance,
           (SELECT COUNT(*)::int FROM wager_transactions WHERE wallet_id = ? AND external_transaction_id = ?) AS txs`,
        ["wager-consumer", messageId, wallet.id, wallet.id, externalTransactionId],
      )) as Array<{ inbox: number; balance: string; txs: number }>;

      expect(residue[0]?.inbox ?? -1).toBe(0);
      expect(Number(residue[0]?.balance)).toBe(80);
      expect(residue[0]?.txs ?? -1).toBe(0);

      const ok = await processWager.executeFromQueue(input, inbox);
      expect(ok.kind).toBe("processed");

      await uow.transactional(async (repos) => {
        const w = await repos.wallets.findById(wallet.id);
        expect(w!.balance.toString()).toBe("72.00");
        const row = await repos.inbox.find("wager-consumer", messageId);
        expect(row?.isProcessed()).toBe(true);
      });
      await assertLedgerReconciliation(uow, wallet.id);
    });
  }, 60_000);

  test("financial TX stays atomic: wallet + ledger + outbox or nothing", async () => {
    await withOrm(async ({ createWallet, processWager, uow, orm }) => {
      const playerId = newId();
      const wallet = await createWallet.execute({
        playerId,
        initialBalance: { amount: "60.00", currency: "BRL" },
      });
      const ext = `atom-${newId()}`;
      const result = await processWager.execute({
        providerId: "atom",
        externalTransactionId: ext,
        idempotencyKey: `atom:${ext}`,
        playerId,
        walletId: wallet.id,
        roundId: "atom",
        gameId: "g",
        kind: "BET",
        money: { amount: "10.00", currency: "BRL" },
      });
      expect(result.status).toBe("PROCESSED");

      const counts = (await orm.em.execute(
        `SELECT
           (SELECT COUNT(*)::int FROM wallet_ledger_entries WHERE wallet_id = ?) AS ledger,
           (SELECT COUNT(*)::int FROM outbox_messages WHERE aggregate_id = ? AND published_at IS NULL) AS outbox,
           (SELECT balance::text FROM wallets WHERE id = ?) AS balance`,
        [wallet.id, wallet.id, wallet.id],
      )) as Array<{ ledger: number; outbox: number; balance: string }>;

      expect(Number(counts[0]?.balance)).toBe(50);
      expect((counts[0]?.ledger ?? 0) >= 2).toBe(true); // OPENING + BET
      expect((counts[0]?.outbox ?? 0) >= 1).toBe(true);
      await assertLedgerReconciliation(uow, wallet.id);
    });
  }, 30_000);
});
