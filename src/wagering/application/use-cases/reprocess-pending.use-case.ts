import { Injectable } from "@nestjs/common";
import { OutboxMessage } from "../../../messaging/domain/outbox-message";
import { newId } from "../../../shared/id";
import { WagerTransaction } from "../../domain/entities/wager-transaction";
import { WalletLedgerEntry } from "../../domain/entities/wallet-ledger-entry";
import {
  FailureCode,
  LedgerDirection,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../domain/enums";
import { CurrencyMismatchError, InsufficientBalanceError } from "../../domain/errors";
import {
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from "../../domain/events/integration-events";
import type { ClockPort, TransactionalRepositories, UnitOfWorkPort } from "../ports/repositories";

const MAX_ATTEMPTS = Number(process.env["REFERENCE_MAX_ATTEMPTS"] ?? 10);

/**
 * Worker: reprocess PENDING_REFERENCE with exponential backoff.
 * Exhausted attempts or TTL → REJECTED REFERENCE_NOT_FOUND.
 */
@Injectable()
export class ReprocessPendingReferencesUseCase {
  constructor(
    private readonly uow: UnitOfWorkPort,
    private readonly clock: ClockPort,
  ) {}

  async execute(
    batchSize = 50,
  ): Promise<{ processed: number; rejected: number; deferred: number }> {
    const now = this.clock.now();
    let processed = 0;
    let rejected = 0;
    let deferred = 0;

    const due = await this.uow.transactional(async (repos) =>
      repos.transactions.claimPendingReferencesDue(now, batchSize),
    );

    for (const claimed of due) {
      const result = await this.uow.transactional(async (repos) => {
        const tx = await repos.transactions.findById(claimed.id);
        if (!tx || tx.status !== WagerTransactionStatus.PendingReference) {
          return "skip" as const;
        }

        const exhausted =
          tx.referenceAttempts >= MAX_ATTEMPTS ||
          (tx.reprocessDeadline !== undefined && tx.reprocessDeadline.getTime() <= now.getTime());

        const refExt = tx.referenceExternalTransactionId;
        const resolved = refExt
          ? await repos.transactions.findByExternalId(tx.providerId, refExt)
          : null;

        if (!resolved || resolved.status !== WagerTransactionStatus.Processed) {
          if (exhausted) {
            const wallet = await repos.wallets.findById(tx.walletId);
            tx.reject(FailureCode.REFERENCE_NOT_FOUND, now, wallet?.balance);
            await repos.transactions.save(tx);
            await enqueueRejected(repos, tx, now);
            return "rejected" as const;
          }
          const delayMs = Math.min(
            1000 * 2 ** Math.min(tx.referenceAttempts + 1, 10),
            15 * 60 * 1000,
          );
          const jitter = delayMs * (0.8 + Math.random() * 0.4);
          tx.scheduleReferenceRetry(now, new Date(now.getTime() + jitter));
          await repos.transactions.save(tx);
          return "deferred" as const;
        }

        if (
          resolved.providerId !== tx.providerId ||
          resolved.playerId !== tx.playerId ||
          resolved.walletId !== tx.walletId ||
          resolved.roundId !== tx.roundId ||
          !WagerTransaction.canReference(tx.kind, resolved.kind)
        ) {
          const wallet = await repos.wallets.findById(tx.walletId);
          tx.reject(FailureCode.REFERENCE_MISMATCH, now, wallet?.balance);
          await repos.transactions.save(tx);
          await enqueueRejected(repos, tx, now);
          return "rejected" as const;
        }

        if (!tx.money.equals(resolved.money)) {
          const wallet = await repos.wallets.findById(tx.walletId);
          tx.reject(FailureCode.REFERENCE_AMOUNT_MISMATCH, now, wallet?.balance);
          await repos.transactions.save(tx);
          await enqueueRejected(repos, tx, now);
          return "rejected" as const;
        }

        const existingReversal = await repos.transactions.findProcessedReversalFor(resolved.id);
        if (existingReversal && existingReversal.id !== tx.id) {
          const wallet = await repos.wallets.findById(tx.walletId);
          tx.reject(FailureCode.REFERENCE_ALREADY_REVERSED, now, wallet?.balance);
          await repos.transactions.save(tx);
          await enqueueRejected(repos, tx, now);
          return "rejected" as const;
        }

        const wallet = await repos.wallets.lockByIdForUpdate(tx.walletId);
        if (!wallet) {
          tx.reject(FailureCode.VALIDATION_ERROR, now);
          await repos.transactions.save(tx);
          await enqueueRejected(repos, tx, now);
          return "rejected" as const;
        }

        try {
          const direction = tx.ledgerDirectionFor(resolved);
          const change =
            direction === LedgerDirection.Debit
              ? wallet.debit(tx.money, now)
              : wallet.credit(tx.money, now);

          tx.markProcessed(resolved.id, now, change.after);
          const entry = WalletLedgerEntry.create({
            id: newId(),
            walletId: wallet.id,
            transactionId: tx.id,
            direction,
            money: tx.money,
            balanceBefore: change.before,
            balanceAfter: change.after,
            createdAt: now,
          });

          await repos.transactions.save(tx);
          await repos.wallets.save(wallet);
          await repos.ledger.insert(entry);
          await enqueueProcessed(repos, tx, now);
          await repos.outbox.enqueue(
            OutboxMessage.enqueue(
              WalletBalanceChanged.from(wallet, entry, {
                eventId: newId(),
                correlationId: tx.id,
                causationId: tx.id,
                occurredAt: now,
              }),
              now,
            ),
          );
          return "processed" as const;
        } catch (err) {
          if (err instanceof InsufficientBalanceError) {
            const code =
              tx.kind === WagerTransactionKind.Refund
                ? FailureCode.REFUND_WOULD_OVERDRAW
                : FailureCode.ROLLBACK_WOULD_OVERDRAW;
            tx.reject(code, now, wallet.balance);
            await repos.transactions.save(tx);
            await enqueueRejected(repos, tx, now);
            return "rejected" as const;
          }
          if (err instanceof CurrencyMismatchError) {
            tx.reject(FailureCode.WALLET_CURRENCY_MISMATCH, now, wallet.balance);
            await repos.transactions.save(tx);
            await enqueueRejected(repos, tx, now);
            return "rejected" as const;
          }
          throw err;
        }
      });

      if (result === "processed") processed += 1;
      else if (result === "rejected") rejected += 1;
      else if (result === "deferred") deferred += 1;
    }

    return { processed, rejected, deferred };
  }
}

async function enqueueProcessed(
  repos: TransactionalRepositories,
  tx: WagerTransaction,
  now: Date,
): Promise<void> {
  await repos.outbox.enqueue(
    OutboxMessage.enqueue(
      WagerTransactionProcessed.from(tx, {
        eventId: newId(),
        correlationId: tx.id,
        causationId: tx.id,
        occurredAt: now,
      }),
      now,
    ),
  );
}

async function enqueueRejected(
  repos: TransactionalRepositories,
  tx: WagerTransaction,
  now: Date,
): Promise<void> {
  await repos.outbox.enqueue(
    OutboxMessage.enqueue(
      WagerTransactionRejected.from(tx, {
        eventId: newId(),
        correlationId: tx.id,
        causationId: tx.id,
        occurredAt: now,
      }),
      now,
    ),
  );
}
