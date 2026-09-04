import type { InboxMessage } from "../../../messaging/domain/inbox-message";
import type { OutboxMessage } from "../../../messaging/domain/outbox-message";
import type { WagerTransaction } from "../../domain/entities/wager-transaction";
import type { Wallet } from "../../domain/entities/wallet";
import type { WalletLedgerEntry } from "../../domain/entities/wallet-ledger-entry";

export interface WalletRepository {
  insert(wallet: Wallet): Promise<void>;
  findById(id: string): Promise<Wallet | null>;
  lockByIdForUpdate(id: string): Promise<Wallet | null>;
  save(wallet: Wallet): Promise<void>;
}

export interface WagerTransactionRepository {
  insert(tx: WagerTransaction): Promise<void>;
  save(tx: WagerTransaction): Promise<void>;
  findById(id: string): Promise<WagerTransaction | null>;
  findByIdempotencyKey(
    providerId: string,
    idempotencyKey: string,
  ): Promise<WagerTransaction | null>;
  findByExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | null>;
  findProcessedReversalFor(referenceTransactionId: string): Promise<WagerTransaction | null>;
  /** SKIP LOCKED batch of PENDING_REFERENCE due for reprocess. */
  claimPendingReferencesDue(now: Date, limit: number): Promise<WagerTransaction[]>;
}

export interface LedgerRepository {
  insert(entry: WalletLedgerEntry): Promise<void>;
  findByWalletId(
    walletId: string,
    options: { limit: number; afterCreatedAt?: Date; afterId?: string },
  ): Promise<WalletLedgerEntry[]>;
  countByWalletId(walletId: string): Promise<number>;
  sumBalanceFromLedger(walletId: string): Promise<{ credit: string; debit: string }>;
}

export interface ReconciliationCheckRecord {
  id: string;
  walletId: string;
  storedBalance: string;
  calculatedBalance: string;
  difference: string;
  consistent: boolean;
  checkedEntries: number;
  createdAt: Date;
}

export interface ReconciliationRepository {
  insert(check: ReconciliationCheckRecord): Promise<void>;
}

export interface OutboxRepository {
  enqueue(message: OutboxMessage): Promise<void>;
  /** FOR UPDATE SKIP LOCKED claim of due unpublished messages. */
  claimDue(now: Date, limit: number): Promise<OutboxMessage[]>;
  /** True unpublished backlog (not just last claimed batch). */
  countUnpublished(): Promise<number>;
  markPublished(id: string, at: Date): Promise<void>;
  scheduleRetry(message: OutboxMessage, now: Date): Promise<void>;
}

export interface InboxRepository {
  /** Insert if absent. Returns existing row when conflict. */
  tryReceive(message: InboxMessage): Promise<{ created: boolean; existing?: InboxMessage }>;
  markProcessed(consumerName: string, messageId: string, at: Date): Promise<void>;
  find(consumerName: string, messageId: string): Promise<InboxMessage | null>;
}

export interface TransactionalRepositories {
  wallets: WalletRepository;
  transactions: WagerTransactionRepository;
  ledger: LedgerRepository;
  outbox: OutboxRepository;
  inbox: InboxRepository;
  reconciliation: ReconciliationRepository;
}

export interface UnitOfWorkPort {
  transactional<T>(fn: (repos: TransactionalRepositories) => Promise<T>): Promise<T>;
}

export interface ClockPort {
  now(): Date;
}

export class SystemClock implements ClockPort {
  now(): Date {
    return new Date();
  }
}
