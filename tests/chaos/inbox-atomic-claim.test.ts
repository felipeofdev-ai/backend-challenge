import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { MikroOrmUnitOfWork } from "../../src/infrastructure/persistence/mikro-orm.unit-of-work";
import { InboxMessage } from "../../src/messaging/domain/inbox-message";
import { newId } from "../../src/shared/id";
import { SystemClock } from "../../src/wagering/application/ports/repositories";
import { ProcessWagerUseCase } from "../../src/wagering/application/use-cases/process-wager.use-case";
import { postgresAvailable, withOrm } from "../helpers/pg";

const pgAvailable = await postgresAvailable();

describe.skipIf(!pgAvailable)("atomicity · inbox INSERT ON CONFLICT", () => {
  test("20 concurrent tryReceive (pooled) → exactly one created winner", async () => {
    await withOrm(async ({ orm }) => {
      const messageId = newId();
      const payloadHash = createHash("sha256").update("same-body", "utf8").digest("hex");
      const receivedAt = new Date();

      // Bound concurrency to pool size (DATABASE_POOL_MAX default 20)
      const workers = 8;
      const total = 40;
      let next = 0;
      const results: Array<{ created: boolean }> = [];
      async function worker(): Promise<void> {
        while (true) {
          const i = next++;
          if (i >= total) return;
          const uow = new MikroOrmUnitOfWork(orm.em.fork());
          const r = await uow.transactional((repos) =>
            repos.inbox.tryReceive(
              InboxMessage.receive({
                messageId,
                consumerName: "wager-consumer",
                payloadHash,
                receivedAt,
              }),
            ),
          );
          results.push(r);
        }
      }
      await Promise.all(Array.from({ length: workers }, () => worker()));

      expect(results.filter((r) => r.created)).toHaveLength(1);
      expect(results.filter((r) => !r.created)).toHaveLength(total - 1);

      const rows = (await orm.em.getConnection().execute(
        `SELECT COUNT(*)::int AS c FROM inbox_messages
         WHERE consumer_name = 'wager-consumer' AND message_id = ?`,
        [messageId],
      )) as Array<{ c: number }>;
      expect(rows[0]?.c).toBe(1);
    });
  }, 60_000);

  test("same messageId divergent payloadHash → conflict (no silent reprocess)", async () => {
    await withOrm(async ({ createWallet, uow }) => {
      const clock = new SystemClock();
      const uc = new ProcessWagerUseCase(uow, clock);
      const playerId = newId();
      const wallet = await createWallet.execute({
        playerId,
        initialBalance: { amount: "30.00", currency: "BRL" },
      });
      const messageId = newId();
      const ext = `hash-${newId()}`;
      const hashA = createHash("sha256").update("body-a", "utf8").digest("hex");
      const hashB = createHash("sha256").update("body-b", "utf8").digest("hex");

      const first = await uc.executeFromQueue(
        {
          providerId: "atom",
          externalTransactionId: ext,
          idempotencyKey: `atom:${ext}`,
          playerId,
          walletId: wallet.id,
          roundId: "h",
          gameId: "g",
          kind: "BET",
          money: { amount: "1.00", currency: "BRL" },
        },
        { consumerName: "wager-consumer", messageId, payloadHash: hashA },
      );
      expect(first.kind).toBe("processed");

      await expect(
        uc.executeFromQueue(
          {
            providerId: "atom",
            externalTransactionId: `${ext}-other`,
            idempotencyKey: `atom:${ext}-other`,
            playerId,
            walletId: wallet.id,
            roundId: "h",
            gameId: "g",
            kind: "BET",
            money: { amount: "2.00", currency: "BRL" },
          },
          { consumerName: "wager-consumer", messageId, payloadHash: hashB },
        ),
      ).rejects.toThrow();
    });
  }, 30_000);
});
