/**
 * Direct SQL-TX probe: inbox INSERT via tryReceive must roll back with the surrounding TX.
 * Guards against regressing to em.getConnection().execute() (wrong pool connection).
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { InboxMessage } from "../../src/messaging/domain/inbox-message";
import { newId } from "../../src/shared/id";
import { postgresAvailable, withOrm } from "../helpers/pg";

const pgAvailable = await postgresAvailable();

describe.skipIf(!pgAvailable)("forensic · inbox same-TX probe", () => {
  test("tryReceive INSERT disappears after transactional rollback", async () => {
    await withOrm(async ({ uow }) => {
      const messageId = newId();
      const payloadHash = createHash("sha256").update(`probe-${messageId}`, "utf8").digest("hex");
      const consumerName = "tx-probe-consumer";

      await expect(
        uow.transactional(async (repos) => {
          const claim = await repos.inbox.tryReceive(
            InboxMessage.receive({
              consumerName,
              messageId,
              payloadHash,
              receivedAt: new Date(),
            }),
          );
          expect(claim.created).toBe(true);

          const inside = await repos.inbox.find(consumerName, messageId);
          expect(inside).not.toBeNull();

          throw new Error("force_rollback_after_inbox_claim");
        }),
      ).rejects.toThrow(/force_rollback_after_inbox_claim/);

      const after = await uow.transactional((repos) => repos.inbox.find(consumerName, messageId));
      expect(after).toBeNull();
    });
  }, 30_000);

  test("abort after claim+markProcessed leaves zero inbox residue", async () => {
    await withOrm(async ({ uow }) => {
      const messageId = newId();
      const payloadHash = createHash("sha256").update(`probe2-${messageId}`, "utf8").digest("hex");
      const consumerName = "tx-probe-consumer";

      await expect(
        uow.transactional(async (repos) => {
          await repos.inbox.tryReceive(
            InboxMessage.receive({
              consumerName,
              messageId,
              payloadHash,
              receivedAt: new Date(),
            }),
          );
          await repos.inbox.markProcessed(consumerName, messageId, new Date());
          throw new Error("force_rollback_after_mark");
        }),
      ).rejects.toThrow(/force_rollback_after_mark/);

      const after = await uow.transactional((repos) => repos.inbox.find(consumerName, messageId));
      expect(after).toBeNull();
    });
  }, 30_000);
});
