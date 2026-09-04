import { InboxMessage } from "../../messaging/domain/inbox-message";
import { OutboxMessage } from "../../messaging/domain/outbox-message";
import type {
  InboxRepository,
  LedgerRepository,
  OutboxRepository,
  ReconciliationCheckRecord,
  ReconciliationRepository,
  TransactionalRepositories,
  UnitOfWorkPort,
  WagerTransactionRepository,
  WalletRepository,
} from "../../wagering/application/ports/repositories";
import { WagerTransaction } from "../../wagering/domain/entities/wager-transaction";
import { Wallet } from "../../wagering/domain/entities/wallet";
import { WalletLedgerEntry } from "../../wagering/domain/entities/wallet-ledger-entry";
import {
  LedgerDirection,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../wagering/domain/enums";
import { Money } from "../../wagering/domain/value-objects/money";

class AsyncMutex {
  private chain: Promise<void> = Promise.resolve();

  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const wait = this.chain;
    this.chain = this.chain.then(() => next);
    await wait;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

/** In-memory Unit of Work — serializes transactions (simulates DB locking for unit tests). */
export class InMemoryUnitOfWork implements UnitOfWorkPort {
  readonly store = {
    wallets: new Map<string, Wallet>(),
    transactions: new Map<string, WagerTransaction>(),
    ledger: [] as WalletLedgerEntry[],
    outbox: [] as OutboxMessage[],
    inbox: new Map<string, InboxMessage>(),
    reconciliation: [] as ReconciliationCheckRecord[],
    byIdempotency: new Map<string, string>(),
    byExternal: new Map<string, string>(),
    byPlayerCurrency: new Map<string, string>(),
  };

  private readonly globalMutex = new AsyncMutex();

  async transactional<T>(fn: (repos: TransactionalRepositories) => Promise<T>): Promise<T> {
    return this.globalMutex.runExclusive(() => fn(this.createRepos()));
  }

  private createRepos(): TransactionalRepositories {
    return {
      wallets: this.walletRepo(),
      transactions: this.txRepo(),
      ledger: this.ledgerRepo(),
      outbox: this.outboxRepo(),
      inbox: this.inboxRepo(),
      reconciliation: this.reconciliationRepo(),
    };
  }

  private reconciliationRepo(): ReconciliationRepository {
    const s = this.store;
    return {
      insert: async (check) => {
        s.reconciliation.push({ ...check });
      },
    };
  }

  private walletRepo(): WalletRepository {
    const s = this.store;
    return {
      insert: async (wallet) => {
        const key = `${wallet.playerId}:${wallet.currency}`;
        if (s.byPlayerCurrency.has(key)) throw uniqueError();
        s.wallets.set(wallet.id, cloneWallet(wallet));
        s.byPlayerCurrency.set(key, wallet.id);
      },
      findById: async (id) => {
        const w = s.wallets.get(id);
        return w ? cloneWallet(w) : null;
      },
      lockByIdForUpdate: async (id) => {
        const w = s.wallets.get(id);
        return w ? cloneWallet(w) : null;
      },
      save: async (wallet) => {
        s.wallets.set(wallet.id, cloneWallet(wallet));
      },
    };
  }

  private txRepo(): WagerTransactionRepository {
    const s = this.store;
    return {
      insert: async (tx) => {
        const idemKey = `${tx.providerId}:${tx.idempotencyKey}`;
        if (s.byIdempotency.has(idemKey)) throw uniqueError();
        const extKey = `${tx.providerId}:${tx.externalTransactionId}`;
        if (s.byExternal.has(extKey)) throw uniqueError();

        if (
          (tx.kind === WagerTransactionKind.Refund || tx.kind === WagerTransactionKind.Rollback) &&
          tx.status === WagerTransactionStatus.Processed &&
          tx.referenceTransactionId
        ) {
          for (const existing of s.transactions.values()) {
            if (
              existing.referenceTransactionId === tx.referenceTransactionId &&
              existing.status === WagerTransactionStatus.Processed &&
              (existing.kind === WagerTransactionKind.Refund ||
                existing.kind === WagerTransactionKind.Rollback)
            ) {
              throw uniqueError();
            }
          }
        }

        s.transactions.set(tx.id, tx);
        s.byIdempotency.set(idemKey, tx.id);
        s.byExternal.set(extKey, tx.id);
      },
      save: async (tx) => {
        s.transactions.set(tx.id, tx);
      },
      findById: async (id) => s.transactions.get(id) ?? null,
      findByIdempotencyKey: async (providerId, idempotencyKey) => {
        const id = s.byIdempotency.get(`${providerId}:${idempotencyKey}`);
        return id ? (s.transactions.get(id) ?? null) : null;
      },
      findByExternalId: async (providerId, externalTransactionId) => {
        const id = s.byExternal.get(`${providerId}:${externalTransactionId}`);
        return id ? (s.transactions.get(id) ?? null) : null;
      },
      findProcessedReversalFor: async (referenceTransactionId) => {
        for (const tx of s.transactions.values()) {
          if (
            tx.referenceTransactionId === referenceTransactionId &&
            tx.status === WagerTransactionStatus.Processed &&
            (tx.kind === WagerTransactionKind.Refund || tx.kind === WagerTransactionKind.Rollback)
          ) {
            return tx;
          }
        }
        return null;
      },
      claimPendingReferencesDue: async (now, limit) => {
        return [...s.transactions.values()]
          .filter(
            (tx) =>
              tx.status === WagerTransactionStatus.PendingReference &&
              tx.nextReprocessAt !== undefined &&
              tx.nextReprocessAt.getTime() <= now.getTime(),
          )
          .slice(0, limit);
      },
    };
  }

  private ledgerRepo(): LedgerRepository {
    const s = this.store;
    return {
      insert: async (entry) => {
        if (s.ledger.some((e) => e.transactionId === entry.transactionId)) {
          throw uniqueError();
        }
        s.ledger.push(entry);
      },
      findByWalletId: async (walletId, options) => {
        let rows = s.ledger
          .filter((e) => e.walletId === walletId)
          .sort(
            (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id),
          );
        if (options.afterCreatedAt && options.afterId) {
          rows = rows.filter(
            (e) =>
              e.createdAt.getTime() > options.afterCreatedAt!.getTime() ||
              (e.createdAt.getTime() === options.afterCreatedAt!.getTime() &&
                e.id > options.afterId!),
          );
        }
        return rows.slice(0, options.limit);
      },
      countByWalletId: async (walletId) => s.ledger.filter((e) => e.walletId === walletId).length,
      sumBalanceFromLedger: async (walletId) => {
        const rows = s.ledger.filter((x) => x.walletId === walletId);
        const currency = rows[0]?.money.currency ?? "BRL";
        let credit = Money.zero(currency);
        let debit = Money.zero(currency);
        for (const e of rows) {
          if (e.direction === LedgerDirection.Credit) credit = credit.add(e.money);
          else debit = debit.add(e.money);
        }
        return { credit: credit.toPersistence(), debit: debit.toPersistence() };
      },
    };
  }

  private outboxRepo(): OutboxRepository {
    const s = this.store;
    return {
      enqueue: async (message) => {
        s.outbox.push(message);
      },
      claimDue: async (now, limit) => {
        const due = s.outbox.filter((m) => m.isPending() && m.isDue(now)).slice(0, limit);
        const leaseMsRaw = Number(process.env["OUTBOX_CLAIM_LEASE_MS"] ?? 30_000);
        const leaseMs = Number.isFinite(leaseMsRaw) && leaseMsRaw > 0 ? leaseMsRaw : 30_000;
        const leaseUntil = new Date(now.getTime() + leaseMs);
        for (const m of due) {
          m.leaseUntil(leaseUntil);
        }
        return due;
      },
      countUnpublished: async () => s.outbox.filter((m) => m.isPending()).length,
      markPublished: async (id, at) => {
        const msg = s.outbox.find((m) => m.id === id);
        msg?.markPublished(at);
      },
      scheduleRetry: async (message, now) => {
        message.scheduleRetry(now);
      },
    };
  }

  private inboxRepo(): InboxRepository {
    const s = this.store;
    return {
      tryReceive: async (message) => {
        const key = `${message.consumerName}:${message.messageId}`;
        const existing = s.inbox.get(key);
        if (existing) return { created: false, existing };
        s.inbox.set(key, message);
        return { created: true };
      },
      markProcessed: async (consumerName, messageId, at) => {
        const key = `${consumerName}:${messageId}`;
        const existing = s.inbox.get(key);
        existing?.markProcessed(at);
      },
      find: async (consumerName, messageId) => {
        return s.inbox.get(`${consumerName}:${messageId}`) ?? null;
      },
    };
  }
}

function uniqueError(): Error {
  const err = new Error("unique violation") as Error & { code: string };
  err.code = "23505";
  return err;
}

function cloneWallet(wallet: Wallet): Wallet {
  return Wallet.rehydrate({
    id: wallet.id,
    playerId: wallet.playerId,
    currency: wallet.currency,
    balance: Money.from(wallet.balance.toJSON()),
    version: wallet.version,
    createdAt: wallet.createdAt,
    updatedAt: wallet.updatedAt,
  });
}
