import { EntityManager, LockMode, UniqueConstraintViolationException } from "@mikro-orm/postgresql";
import { InboxMessage } from "../../messaging/domain/inbox-message";
import { OutboxMessage } from "../../messaging/domain/outbox-message";
import { classifyPgError } from "../../shared/pg-error";
import type {
  InboxRepository,
  LedgerRepository,
  OutboxRepository,
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
  FailureCode,
  LedgerDirection,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../wagering/domain/enums";
import { DependencyUnavailableError, LockTimeoutError } from "../../wagering/domain/errors";
import { Money } from "../../wagering/domain/value-objects/money";
import { InboxMessageOrmEntity } from "../orm/entities/inbox-message.orm-entity";
import { OutboxMessageOrmEntity } from "../orm/entities/outbox-message.orm-entity";
import { ReconciliationCheckOrmEntity } from "../orm/entities/reconciliation-check.orm-entity";
import { WagerTransactionOrmEntity } from "../orm/entities/wager-transaction.orm-entity";
import { WalletLedgerEntryOrmEntity } from "../orm/entities/wallet-ledger-entry.orm-entity";
import { WalletOrmEntity } from "../orm/entities/wallet.orm-entity";

/**
 * MikroORM Unit of Work.
 * Every financial effect runs inside em.transactional().
 * Wallet mutations use LockMode.PESSIMISTIC_WRITE (SELECT … FOR UPDATE).
 */
export class MikroOrmUnitOfWork implements UnitOfWorkPort {
  constructor(private readonly em: EntityManager) {}

  async transactional<T>(fn: (repos: TransactionalRepositories) => Promise<T>): Promise<T> {
    try {
      return await this.em.transactional(async (tem) => {
        const lockMsRaw = Number(process.env["LOCK_TIMEOUT_MS"] ?? 2000);
        const lockMs = Number.isFinite(lockMsRaw) && lockMsRaw > 0 ? Math.floor(lockMsRaw) : 2000;
        await tem.execute(`SET LOCAL lock_timeout = '${lockMs}ms'`);
        const repos = createRepos(tem);
        try {
          return await fn(repos);
        } catch (err) {
          if (err instanceof UniqueConstraintViolationException) {
            const wrapped = new Error(err.message) as Error & { code: string; name: string };
            wrapped.code = "23505";
            wrapped.name = "UniqueConstraintViolationException";
            throw wrapped;
          }
          const kind = classifyPgError(err);
          if (kind === "lock_timeout") {
            throw new LockTimeoutError();
          }
          if (kind === "unavailable") {
            throw new DependencyUnavailableError("postgres");
          }
          throw err;
        }
      });
    } catch (err) {
      // Pool acquire timeout happens before the inner callback — map to 503
      if (err instanceof LockTimeoutError || err instanceof DependencyUnavailableError) throw err;
      const kind = classifyPgError(err);
      if (kind === "unavailable") throw new DependencyUnavailableError("postgres");
      if (kind === "lock_timeout") throw new LockTimeoutError();
      throw err;
    }
  }
}

function createRepos(em: EntityManager): TransactionalRepositories {
  return {
    wallets: walletRepo(em),
    transactions: txRepo(em),
    ledger: ledgerRepo(em),
    outbox: outboxRepo(em),
    inbox: inboxRepo(em),
    reconciliation: reconciliationRepo(em),
  };
}

function reconciliationRepo(em: EntityManager): ReconciliationRepository {
  return {
    insert: async (check) => {
      const row = new ReconciliationCheckOrmEntity();
      row.id = check.id;
      row.walletId = check.walletId;
      row.storedBalance = check.storedBalance;
      row.calculatedBalance = check.calculatedBalance;
      row.difference = check.difference;
      row.consistent = check.consistent;
      row.checkedEntries = check.checkedEntries;
      row.createdAt = check.createdAt;
      await em.persist(row).flush();
    },
  };
}

function walletRepo(em: EntityManager): WalletRepository {
  return {
    insert: async (wallet) => {
      const row = toWalletOrm(wallet);
      await em.persist(row).flush();
    },
    findById: async (id) => {
      const row = await em.findOne(WalletOrmEntity, { id });
      return row ? toWalletDomain(row) : null;
    },
    lockByIdForUpdate: async (id) => {
      const row = await em.findOne(
        WalletOrmEntity,
        { id },
        { lockMode: LockMode.PESSIMISTIC_WRITE },
      );
      return row ? toWalletDomain(row) : null;
    },
    save: async (wallet) => {
      const row = await em.findOne(
        WalletOrmEntity,
        { id: wallet.id },
        { lockMode: LockMode.PESSIMISTIC_WRITE },
      );
      if (!row) throw new Error(`Wallet ${wallet.id} not found for save`);
      row.balance = wallet.balance.toPersistence();
      row.version = String(wallet.version);
      row.updatedAt = wallet.updatedAt;
      await em.flush();
    },
  };
}

function txRepo(em: EntityManager): WagerTransactionRepository {
  return {
    insert: async (tx) => {
      await em.persist(toTxOrm(tx)).flush();
    },
    save: async (tx) => {
      const row = await em.findOne(WagerTransactionOrmEntity, { id: tx.id });
      if (!row) throw new Error(`Transaction ${tx.id} not found for save`);
      applyTxToOrm(row, tx);
      await em.flush();
    },
    findById: async (id) => {
      const row = await em.findOne(WagerTransactionOrmEntity, { id });
      return row ? toTxDomain(row) : null;
    },
    findByIdempotencyKey: async (providerId, idempotencyKey) => {
      const row = await em.findOne(WagerTransactionOrmEntity, {
        providerId,
        idempotencyKey,
      });
      return row ? toTxDomain(row) : null;
    },
    findByExternalId: async (providerId, externalTransactionId) => {
      const row = await em.findOne(WagerTransactionOrmEntity, {
        providerId,
        externalTransactionId,
      });
      return row ? toTxDomain(row) : null;
    },
    findProcessedReversalFor: async (referenceTransactionId) => {
      const row = await em.findOne(WagerTransactionOrmEntity, {
        referenceTransactionId,
        status: WagerTransactionStatus.Processed,
        kind: { $in: [WagerTransactionKind.Refund, WagerTransactionKind.Rollback] },
      });
      return row ? toTxDomain(row) : null;
    },
    claimPendingReferencesDue: async (now, limit) => {
      const rows = await em
        .createQueryBuilder(WagerTransactionOrmEntity, "t")
        .where({
          status: WagerTransactionStatus.PendingReference,
          nextReprocessAt: { $lte: now },
        })
        .orderBy({ nextReprocessAt: "ASC" })
        .limit(limit)
        .setLockMode(LockMode.PESSIMISTIC_PARTIAL_WRITE)
        .getResult();
      return rows.map(toTxDomain);
    },
  };
}

function ledgerRepo(em: EntityManager): LedgerRepository {
  return {
    insert: async (entry) => {
      await em.persist(toLedgerOrm(entry)).flush();
    },
    findByWalletId: async (walletId, options) => {
      const qb = em
        .createQueryBuilder(WalletLedgerEntryOrmEntity, "e")
        .where({ walletId })
        .orderBy({ createdAt: "ASC", id: "ASC" })
        .limit(options.limit);

      if (options.afterCreatedAt && options.afterId) {
        qb.andWhere("(e.created_at, e.id) > (?, ?)", [options.afterCreatedAt, options.afterId]);
      }

      const rows = await qb.getResult();
      return rows.map(toLedgerDomain);
    },
    countByWalletId: async (walletId) => {
      return em.count(WalletLedgerEntryOrmEntity, { walletId });
    },
    sumBalanceFromLedger: async (walletId) => {
      const rows = await em.find(WalletLedgerEntryOrmEntity, { walletId });
      if (rows.length === 0) {
        return { credit: "0.00", debit: "0.00" };
      }
      const currency = rows[0]!.currency;
      let credit = Money.zero(currency);
      let debit = Money.zero(currency);
      for (const r of rows) {
        const m = Money.from({ amount: r.amount, currency: r.currency });
        if (r.direction === LedgerDirection.Credit) credit = credit.add(m);
        else debit = debit.add(m);
      }
      return { credit: credit.toPersistence(), debit: debit.toPersistence() };
    },
  };
}

function outboxRepo(em: EntityManager): OutboxRepository {
  return {
    enqueue: async (message) => {
      const row = new OutboxMessageOrmEntity();
      row.id = message.id;
      row.aggregateId = message.aggregateId;
      row.eventType = message.eventType;
      row.version = message.version;
      row.payload = { ...message.payload };
      row.correlationId = message.correlationId;
      row.causationId = message.causationId ?? null;
      row.occurredAt = message.occurredAt;
      row.attempts = message.attempts;
      row.nextAttemptAt = message.nextAttemptAt ?? message.occurredAt;
      row.publishedAt = message.publishedAt ?? null;
      row.createdAt = message.createdAt;
      await em.persist(row).flush();
    },
    claimDue: async (now, limit) => {
      const rows = await em
        .createQueryBuilder(OutboxMessageOrmEntity, "o")
        .where({ publishedAt: null, nextAttemptAt: { $lte: now } })
        .orderBy({ occurredAt: "ASC" })
        .limit(limit)
        .setLockMode(LockMode.PESSIMISTIC_PARTIAL_WRITE)
        .getResult();
      // Lease claimed rows so concurrent publishers (after this TX) skip them.
      const leaseMsRaw = Number(process.env["OUTBOX_CLAIM_LEASE_MS"] ?? 30_000);
      const leaseMs = Number.isFinite(leaseMsRaw) && leaseMsRaw > 0 ? leaseMsRaw : 30_000;
      const leaseUntil = new Date(now.getTime() + leaseMs);
      for (const row of rows) {
        row.nextAttemptAt = leaseUntil;
      }
      if (rows.length > 0) await em.flush();
      return rows.map(toOutboxDomain);
    },
    countUnpublished: async () => {
      return em.count(OutboxMessageOrmEntity, { publishedAt: null });
    },
    markPublished: async (id, at) => {
      const row = await em.findOne(OutboxMessageOrmEntity, { id });
      if (!row) return;
      row.publishedAt = at;
      await em.flush();
    },
    scheduleRetry: async (message, now) => {
      message.scheduleRetry(now);
      const row = await em.findOne(OutboxMessageOrmEntity, { id: message.id });
      if (!row) return;
      row.attempts = message.attempts;
      row.nextAttemptAt = message.nextAttemptAt ?? now;
      await em.flush();
    },
  };
}

function inboxRepo(em: EntityManager): InboxRepository {
  return {
    tryReceive: async (message) => {
      // Atomic claim on the SAME connection as em.transactional (use em.execute, not getConnection)
      const inserted = (await em.execute(
        `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at, processed_at)
         VALUES (?, ?, ?, ?, NULL)
         ON CONFLICT (consumer_name, message_id) DO NOTHING
         RETURNING message_id`,
        [message.consumerName, message.messageId, message.payloadHash, message.receivedAt],
      )) as Array<{ message_id: string }>;

      if (inserted.length > 0) {
        return { created: true };
      }

      const existing = await em.findOne(InboxMessageOrmEntity, {
        consumerName: message.consumerName,
        messageId: message.messageId,
      });
      if (!existing) {
        // Extremely rare: conflict without readable row in same TX — treat as in-flight
        return { created: false };
      }
      return { created: false, existing: toInboxDomain(existing) };
    },
    markProcessed: async (consumerName, messageId, at) => {
      const row = await em.findOne(InboxMessageOrmEntity, { consumerName, messageId });
      if (!row) return;
      row.processedAt = at;
      await em.flush();
    },
    find: async (consumerName, messageId) => {
      const row = await em.findOne(InboxMessageOrmEntity, { consumerName, messageId });
      return row ? toInboxDomain(row) : null;
    },
  };
}

function toOutboxDomain(row: OutboxMessageOrmEntity): OutboxMessage {
  return OutboxMessage.rehydrate({
    id: row.id,
    aggregateId: row.aggregateId,
    eventType: row.eventType,
    version: row.version,
    payload: row.payload,
    correlationId: row.correlationId,
    ...(row.causationId ? { causationId: row.causationId } : {}),
    occurredAt: row.occurredAt,
    attempts: row.attempts,
    ...(row.nextAttemptAt ? { nextAttemptAt: row.nextAttemptAt } : {}),
    ...(row.publishedAt ? { publishedAt: row.publishedAt } : {}),
    createdAt: row.createdAt,
  });
}

function toInboxDomain(row: InboxMessageOrmEntity): InboxMessage {
  return InboxMessage.rehydrate({
    messageId: row.messageId,
    consumerName: row.consumerName,
    payloadHash: row.payloadHash,
    receivedAt: row.receivedAt,
    ...(row.processedAt ? { processedAt: row.processedAt } : {}),
  });
}

function toWalletOrm(wallet: Wallet): WalletOrmEntity {
  const row = new WalletOrmEntity();
  row.id = wallet.id;
  row.playerId = wallet.playerId;
  row.currency = wallet.currency;
  row.balance = wallet.balance.toPersistence();
  row.version = String(wallet.version);
  row.createdAt = wallet.createdAt;
  row.updatedAt = wallet.updatedAt;
  return row;
}

function toWalletDomain(row: WalletOrmEntity): Wallet {
  return Wallet.rehydrate({
    id: row.id,
    playerId: row.playerId,
    currency: row.currency,
    balance: Money.from({ amount: normalizeDecimal(row.balance), currency: row.currency }),
    version: Number(row.version),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

function toTxOrm(tx: WagerTransaction): WagerTransactionOrmEntity {
  const row = new WagerTransactionOrmEntity();
  applyTxToOrm(row, tx);
  return row;
}

function applyTxToOrm(row: WagerTransactionOrmEntity, tx: WagerTransaction): void {
  row.id = tx.id;
  row.providerId = tx.providerId;
  row.externalTransactionId = tx.externalTransactionId;
  row.idempotencyKey = tx.idempotencyKey;
  row.payloadHash = tx.payloadHash;
  row.walletId = tx.walletId;
  row.playerId = tx.playerId;
  row.roundId = tx.roundId;
  row.gameId = tx.gameId;
  row.kind = tx.kind;
  row.status = tx.status;
  row.amount = tx.money.toPersistence();
  row.currency = tx.money.currency;
  row.referenceExternalTransactionId = tx.referenceExternalTransactionId ?? null;
  row.referenceTransactionId = tx.referenceTransactionId ?? null;
  row.failureCode = tx.failureCode ?? null;
  row.resultBalance = tx.resultBalance?.toPersistence() ?? null;
  row.referenceAttempts = tx.referenceAttempts;
  row.nextReprocessAt = tx.nextReprocessAt ?? null;
  row.reprocessDeadline = tx.reprocessDeadline ?? null;
  row.createdAt = tx.createdAt;
  row.processedAt = tx.processedAt ?? null;
}

function toTxDomain(row: WagerTransactionOrmEntity): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: row.id,
    providerId: row.providerId,
    externalTransactionId: row.externalTransactionId,
    idempotencyKey: row.idempotencyKey,
    payloadHash: row.payloadHash,
    walletId: row.walletId,
    playerId: row.playerId,
    roundId: row.roundId,
    gameId: row.gameId,
    kind: row.kind as WagerTransactionKind,
    money: Money.from({
      amount: normalizeDecimal(row.amount),
      currency: row.currency,
    }),
    ...(row.referenceExternalTransactionId
      ? { referenceExternalTransactionId: row.referenceExternalTransactionId }
      : {}),
    createdAt: row.createdAt,
    status: row.status as WagerTransactionStatus,
    ...(row.referenceTransactionId ? { referenceTransactionId: row.referenceTransactionId } : {}),
    ...(row.failureCode ? { failureCode: row.failureCode as FailureCode } : {}),
    ...(row.processedAt ? { processedAt: row.processedAt } : {}),
    ...(row.resultBalance
      ? {
          resultBalance: Money.from({
            amount: normalizeDecimal(row.resultBalance),
            currency: row.currency,
          }),
        }
      : {}),
    referenceAttempts: row.referenceAttempts,
    ...(row.nextReprocessAt ? { nextReprocessAt: row.nextReprocessAt } : {}),
    ...(row.reprocessDeadline ? { reprocessDeadline: row.reprocessDeadline } : {}),
  });
}

function toLedgerOrm(entry: WalletLedgerEntry): WalletLedgerEntryOrmEntity {
  const row = new WalletLedgerEntryOrmEntity();
  row.id = entry.id;
  row.walletId = entry.walletId;
  row.transactionId = entry.transactionId;
  row.direction = entry.direction;
  row.amount = entry.money.toPersistence();
  row.currency = entry.money.currency;
  row.balanceBefore = entry.balanceBefore.toPersistence();
  row.balanceAfter = entry.balanceAfter.toPersistence();
  row.createdAt = entry.createdAt;
  return row;
}

function toLedgerDomain(row: WalletLedgerEntryOrmEntity): WalletLedgerEntry {
  return WalletLedgerEntry.rehydrate({
    id: row.id,
    walletId: row.walletId,
    transactionId: row.transactionId,
    direction: row.direction as LedgerDirection,
    money: Money.from({ amount: normalizeDecimal(row.amount), currency: row.currency }),
    balanceBefore: Money.from({
      amount: normalizeDecimal(row.balanceBefore),
      currency: row.currency,
    }),
    balanceAfter: Money.from({
      amount: normalizeDecimal(row.balanceAfter),
      currency: row.currency,
    }),
    createdAt: row.createdAt,
  });
}

function normalizeDecimal(value: string | number): string {
  const s = String(value);
  if (!s.includes(".")) return `${s}.00`;
  const [w, f = ""] = s.split(".");
  if (f.length > 2) {
    throw new Error(`Refusing to truncate money scale on read: ${s}`);
  }
  return `${w}.${f.padEnd(2, "0")}`;
}
