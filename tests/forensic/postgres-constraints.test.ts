import { describe, expect, test } from "bun:test";
import { InboxMessage } from "../../src/messaging/domain/inbox-message";
import { newId } from "../../src/shared/id";
import { SystemClock } from "../../src/wagering/application/ports/repositories";
import { ReconcileWalletUseCase } from "../../src/wagering/application/use-cases/reconcile-wallet.use-case";
import { ReprocessPendingReferencesUseCase } from "../../src/wagering/application/use-cases/reprocess-pending.use-case";
import { FailureCode, WagerTransactionStatus } from "../../src/wagering/domain";
import { assertLedgerReconciliation, postgresAvailable, withOrm } from "../helpers/pg";

const pgAvailable = await postgresAvailable();

describe.skipIf(!pgAvailable)("forensic · PostgreSQL constraints & races", () => {
  test("ledger immutability trigger blocks UPDATE and DELETE", async () => {
    await withOrm(async ({ createWallet, processWager, orm }) => {
      const playerId = newId();
      const wallet = await createWallet.execute({
        playerId,
        initialBalance: { amount: "100.00", currency: "BRL" },
      });
      await processWager.execute({
        providerId: "p",
        externalTransactionId: `immut-${newId()}`,
        idempotencyKey: `p:immut-${newId()}`,
        playerId,
        walletId: wallet.id,
        roundId: "r",
        gameId: "g",
        kind: "BET",
        money: { amount: "5.00", currency: "BRL" },
      });

      const em = orm.em.fork();
      const rows = await em
        .getConnection()
        .execute(`SELECT id FROM wallet_ledger_entries WHERE wallet_id = ? LIMIT 1`, [wallet.id]);
      const ledgerId = (rows as Array<{ id: string }>)[0]?.id;
      expect(ledgerId).toBeTruthy();

      let updateBlocked = false;
      try {
        await em
          .getConnection()
          .execute(`UPDATE wallet_ledger_entries SET amount = amount WHERE id = ?`, [ledgerId]);
      } catch (err) {
        updateBlocked = String(err).includes("immutable") || String(err).includes("ledger");
      }
      expect(updateBlocked).toBe(true);

      let deleteBlocked = false;
      try {
        await em
          .getConnection()
          .execute(`DELETE FROM wallet_ledger_entries WHERE id = ?`, [ledgerId]);
      } catch (err) {
        deleteBlocked = String(err).includes("immutable") || String(err).includes("ledger");
      }
      expect(deleteBlocked).toBe(true);
    });
  }, 30_000);

  test("deferred trigger rejects PROCESSED BET without ledger row", async () => {
    await withOrm(async ({ createWallet, orm }) => {
      const playerId = newId();
      const wallet = await createWallet.execute({
        playerId,
        initialBalance: { amount: "40.00", currency: "BRL" },
      });
      const txId = newId();
      const em = orm.em.fork();
      let blocked = false;
      try {
        await em.transactional(async (tem) => {
          await tem.getConnection().execute(
            `INSERT INTO wager_transactions (
               id, provider_id, external_transaction_id, idempotency_key, payload_hash,
               wallet_id, player_id, round_id, game_id, kind, status, amount, currency,
               reference_attempts, created_at
             ) VALUES (
               ?, 'p', ?, ?, 'hash',
               ?, ?, 'r', 'g', 'BET', 'PROCESSED', '1.00', 'BRL',
               0, NOW()
             )`,
            [txId, `nolegger-${newId()}`, `p:nolegger-${newId()}`, wallet.id, playerId],
          );
        });
      } catch (err) {
        blocked =
          String(err).includes("no ledger entry") ||
          String(err).includes("check_violation") ||
          String(err).includes("23514");
      }
      expect(blocked).toBe(true);
    });
  }, 30_000);

  test("PROCESSED REFUND/ROLLBACK without reference_transaction_id is rejected by CHECK", async () => {
    await withOrm(async ({ createWallet, orm }) => {
      const playerId = newId();
      const wallet = await createWallet.execute({
        playerId,
        initialBalance: { amount: "40.00", currency: "BRL" },
      });
      const em = orm.em.fork();
      const txId = newId();
      let blocked = false;
      try {
        await em.execute(
          `INSERT INTO wager_transactions (
             id, provider_id, external_transaction_id, idempotency_key, payload_hash,
             wallet_id, player_id, round_id, game_id, kind, status, amount, currency,
             reference_external_transaction_id, reference_transaction_id,
             reference_attempts, created_at, processed_at, result_balance
           ) VALUES (
             ?, 'p', ?, ?, 'hash',
             ?, ?, 'r', 'g', 'REFUND', 'PROCESSED', '5.00', 'BRL',
             'missing-bet', NULL,
             0, NOW(), NOW(), '45.00'
           )`,
          [txId, `nullref-${newId()}`, `p:nullref-${newId()}`, wallet.id, playerId],
        );
      } catch (err) {
        blocked =
          String(err).includes("chk_processed_reversal_has_ref") ||
          String(err).includes("check_violation") ||
          String(err).includes("23514");
      }
      expect(blocked).toBe(true);
    });
  }, 30_000);

  test("CHECK(balance >= 0) survives application-layer race winner", async () => {
    await withOrm(async ({ createWallet, processWager, uow }) => {
      const playerId = newId();
      const wallet = await createWallet.execute({
        playerId,
        initialBalance: { amount: "50.00", currency: "BRL" },
      });
      const results = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          processWager.execute({
            providerId: "p",
            externalTransactionId: `neg-${i}-${newId()}`,
            idempotencyKey: `p:neg-${i}-${newId()}`,
            playerId,
            walletId: wallet.id,
            roundId: "neg",
            gameId: "g",
            kind: "BET",
            money: { amount: "40.00", currency: "BRL" },
          }),
        ),
      );
      const processed = results.filter((r) => r.status === WagerTransactionStatus.Processed);
      expect(processed.length).toBe(1);
      await uow.transactional(async (repos) => {
        const w = await repos.wallets.findById(wallet.id);
        expect(w!.balance.toString()).toBe("10.00");
        expect(Number(w!.balance.toString())).toBeGreaterThanOrEqual(0);
      });
      await assertLedgerReconciliation(uow, wallet.id);
    });
  }, 60_000);

  test("two concurrent REFUNDs of same BET → exactly one credit", async () => {
    await withOrm(async ({ createWallet, processWager, uow }) => {
      const playerId = newId();
      const wallet = await createWallet.execute({
        playerId,
        initialBalance: { amount: "100.00", currency: "BRL" },
      });
      const betExt = `bet-${newId()}`;
      await processWager.execute({
        providerId: "p",
        externalTransactionId: betExt,
        idempotencyKey: `p:${betExt}`,
        playerId,
        walletId: wallet.id,
        roundId: "r",
        gameId: "g",
        kind: "BET",
        money: { amount: "25.00", currency: "BRL" },
      });

      const [a, b] = await Promise.all([
        processWager.execute({
          providerId: "p",
          externalTransactionId: `rf-a-${newId()}`,
          idempotencyKey: `p:rf-a-${newId()}`,
          playerId,
          walletId: wallet.id,
          roundId: "r",
          gameId: "g",
          kind: "REFUND",
          money: { amount: "25.00", currency: "BRL" },
          referenceExternalTransactionId: betExt,
        }),
        processWager.execute({
          providerId: "p",
          externalTransactionId: `rf-b-${newId()}`,
          idempotencyKey: `p:rf-b-${newId()}`,
          playerId,
          walletId: wallet.id,
          roundId: "r",
          gameId: "g",
          kind: "REFUND",
          money: { amount: "25.00", currency: "BRL" },
          referenceExternalTransactionId: betExt,
        }),
      ]);

      const statuses = [a.status, b.status].sort();
      expect(statuses).toEqual([WagerTransactionStatus.Processed, WagerTransactionStatus.Rejected]);
      const rejected = a.status === WagerTransactionStatus.Rejected ? a : b;
      expect(rejected.failureCode).toBe(FailureCode.REFERENCE_ALREADY_REVERSED);

      await uow.transactional(async (repos) => {
        const w = await repos.wallets.findById(wallet.id);
        expect(w!.balance.toString()).toBe("100.00");
        const ledger = await repos.ledger.findByWalletId(wallet.id, { limit: 50 });
        // OPENING credit + exactly one REFUND credit
        expect(ledger.filter((e) => e.direction === "CREDIT")).toHaveLength(2);
        expect(ledger.filter((e) => e.direction === "DEBIT")).toHaveLength(1);
      });
      await assertLedgerReconciliation(uow, wallet.id);
    });
  }, 60_000);

  test("inbox PK prevents duplicate message processing marker", async () => {
    await withOrm(async ({ uow }) => {
      const now = new Date();
      const msg = InboxMessage.receive({
        messageId: `inbox-${newId()}`,
        consumerName: "wager-consumer",
        payloadHash: "b".repeat(64),
        receivedAt: now,
      });
      const first = await uow.transactional((r) => r.inbox.tryReceive(msg));
      const second = await uow.transactional((r) => r.inbox.tryReceive(msg));
      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
    });
  }, 30_000);

  test("pending REFUND exhausts to REFERENCE_NOT_FOUND after deadline", async () => {
    await withOrm(async ({ createWallet, processWager, uow, orm }) => {
      const clock = new SystemClock();
      const reprocess = new ReprocessPendingReferencesUseCase(uow, clock);
      const playerId = newId();
      const wallet = await createWallet.execute({
        playerId,
        initialBalance: { amount: "100.00", currency: "BRL" },
      });
      const pending = await processWager.execute({
        providerId: "p",
        externalTransactionId: `orphan-rf-${newId()}`,
        idempotencyKey: `p:orphan-${newId()}`,
        playerId,
        walletId: wallet.id,
        roundId: "r",
        gameId: "g",
        kind: "REFUND",
        money: { amount: "10.00", currency: "BRL" },
        referenceExternalTransactionId: `missing-${newId()}`,
      });
      expect(pending.status).toBe(WagerTransactionStatus.PendingReference);

      // Force deadline + due in the past via SQL (simulates TTL expiry)
      await orm.em.getConnection().execute(
        `UPDATE wager_transactions
         SET next_reprocess_at = now() - interval '1 minute',
             reprocess_deadline = now() - interval '1 minute',
             reference_attempts = 10
         WHERE id = ?`,
        [pending.transactionId],
      );

      const tick = await reprocess.execute(10);
      expect(tick.rejected).toBeGreaterThanOrEqual(1);

      await uow.transactional(async (repos) => {
        const tx = await repos.transactions.findById(pending.transactionId);
        expect(tx!.status).toBe(WagerTransactionStatus.Rejected);
        expect(tx!.failureCode).toBe(FailureCode.REFERENCE_NOT_FOUND);
        const w = await repos.wallets.findById(wallet.id);
        expect(w!.balance.toString()).toBe("100.00");
      });
    });
  }, 30_000);

  test("reconciliation persists audit row for healthy wallet", async () => {
    await withOrm(async ({ createWallet, processWager, uow, orm }) => {
      const clock = new SystemClock();
      const reconcile = new ReconcileWalletUseCase(uow, clock);
      const playerId = newId();
      const wallet = await createWallet.execute({
        playerId,
        initialBalance: { amount: "77.00", currency: "BRL" },
      });
      await processWager.execute({
        providerId: "p",
        externalTransactionId: `rec-${newId()}`,
        idempotencyKey: `p:rec-${newId()}`,
        playerId,
        walletId: wallet.id,
        roundId: "r",
        gameId: "g",
        kind: "BET",
        money: { amount: "7.00", currency: "BRL" },
      });
      const result = await reconcile.execute(wallet.id);
      expect(result.consistent).toBe(true);

      const rows = await orm.em
        .getConnection()
        .execute(`SELECT consistent, checked_entries FROM reconciliation_checks WHERE id = ?`, [
          result.id,
        ]);
      expect((rows as Array<{ consistent: boolean }>)[0]?.consistent).toBe(true);
    });
  }, 30_000);

  test("mixed parallel BET/WIN/LOSS on one wallet keeps ledger identity", async () => {
    await withOrm(async ({ createWallet, processWager, uow }) => {
      const playerId = newId();
      const wallet = await createWallet.execute({
        playerId,
        initialBalance: { amount: "500.00", currency: "BRL" },
      });

      // sequential bets first so WINs have references
      const betIds: string[] = [];
      for (let i = 0; i < 5; i++) {
        const ext = `mix-bet-${i}-${newId()}`;
        betIds.push(ext);
        await processWager.execute({
          providerId: "p",
          externalTransactionId: ext,
          idempotencyKey: `p:${ext}`,
          playerId,
          walletId: wallet.id,
          roundId: `r${i}`,
          gameId: "g",
          kind: "BET",
          money: { amount: "10.00", currency: "BRL" },
        });
      }

      await Promise.all(
        betIds.map((betExt, i) => {
          if (i % 2 === 0) {
            return processWager.execute({
              providerId: "p",
              externalTransactionId: `mix-win-${i}-${newId()}`,
              idempotencyKey: `p:mix-win-${i}-${newId()}`,
              playerId,
              walletId: wallet.id,
              roundId: `r${i}`,
              gameId: "g",
              kind: "WIN",
              money: { amount: "22.00", currency: "BRL" },
              referenceExternalTransactionId: betExt,
            });
          }
          return processWager.execute({
            providerId: "p",
            externalTransactionId: `mix-loss-${i}-${newId()}`,
            idempotencyKey: `p:mix-loss-${i}-${newId()}`,
            playerId,
            walletId: wallet.id,
            roundId: `r${i}`,
            gameId: "g",
            kind: "LOSS",
            money: { amount: "10.00", currency: "BRL" },
          });
        }),
      );

      await assertLedgerReconciliation(uow, wallet.id);
      await uow.transactional(async (repos) => {
        const w = await repos.wallets.findById(wallet.id);
        // 500 - 5*10 + 3*22 (wins on even indices 0,2,4) = 500 - 50 + 66 = 516
        expect(w!.balance.toString()).toBe("516.00");
      });
    });
  }, 60_000);
});
