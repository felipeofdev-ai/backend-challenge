import { Injectable } from "@nestjs/common";
import { InboxMessage } from "../../../messaging/domain/inbox-message";
import { OutboxMessage } from "../../../messaging/domain/outbox-message";
import { canonicalPayloadHash } from "../../../shared/canonical-hash";
import { newId } from "../../../shared/id";
import { isUniqueViolation } from "../../../shared/unique-violation";
import { WagerTransaction } from "../../domain/entities/wager-transaction";
import { Wallet } from "../../domain/entities/wallet";
import { WalletLedgerEntry } from "../../domain/entities/wallet-ledger-entry";
import {
  FailureCode,
  LedgerDirection,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../domain/enums";
import {
  CurrencyMismatchError,
  DomainError,
  InsufficientBalanceError,
  LockTimeoutError,
} from "../../domain/errors";
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from "../../domain/events/integration-events";
import { Money } from "../../domain/value-objects/money";
import type {
  InboxDedupContext,
  ProcessWagerInput,
  ProcessWagerResult,
  QueueProcessOutcome,
} from "../dto/wager.dto";
import { NoopProcessMetrics, type ProcessMetricsPort } from "../ports/metrics.port";
import {
  type ProviderIdentityPort,
  StaticProviderIdentityAdapter,
} from "../ports/provider-identity.port";
import type { ClockPort, TransactionalRepositories, UnitOfWorkPort } from "../ports/repositories";

const KIND_MAP: Record<string, WagerTransactionKind> = {
  BET: WagerTransactionKind.Bet,
  WIN: WagerTransactionKind.Win,
  LOSS: WagerTransactionKind.Loss,
  REFUND: WagerTransactionKind.Refund,
  ROLLBACK: WagerTransactionKind.Rollback,
  OPENING: WagerTransactionKind.Opening,
};

const REFERENCE_TTL_MS = 24 * 60 * 60 * 1000;
const FIRST_REPROCESS_DELAY_MS = 30_000;

@Injectable()
export class ProcessWagerUseCase {
  constructor(
    private readonly uow: UnitOfWorkPort,
    private readonly clock: ClockPort,
    private readonly providers: ProviderIdentityPort = new StaticProviderIdentityAdapter(),
    private readonly metrics: ProcessMetricsPort = new NoopProcessMetrics(),
  ) {}

  async execute(input: ProcessWagerInput, attempt = 0): Promise<ProcessWagerResult> {
    const prepared = await this.prepare(input);
    const correlationId = input.correlationId ?? newId();
    const now = this.clock.now();

    try {
      return await this.uow.transactional(async (repos) =>
        this.runFinancial(repos, input, prepared, correlationId, now),
      );
    } catch (err) {
      if (isRetryableWriteConflict(err) && attempt < 3) {
        this.metrics.recordLockConflict();
        return this.execute(input, attempt + 1);
      }
      if (err instanceof ConcurrentWriteConflictError) {
        throw new DomainError(
          FailureCode.IDEMPOTENCY_CONFLICT,
          "Concurrent write conflict exhausted retries",
        );
      }
      throw err;
    }
  }

  /**
   * SQS entry: inbox claim + financial effects + inbox markProcessed in ONE SQL TX.
   * Transient failures roll back the inbox insert so redelivery can reclaim.
   */
  async executeFromQueue(
    input: ProcessWagerInput,
    inbox: InboxDedupContext,
    attempt = 0,
  ): Promise<QueueProcessOutcome> {
    let prepared: { kind: WagerTransactionKind; money: Money; payloadHash: string };
    try {
      prepared = await this.prepare(input);
    } catch (err) {
      if (err instanceof DomainError && !err.retryable) {
        await this.uow.transactional(async (repos) => {
          await this.claimInbox(repos, inbox, this.clock.now());
          await repos.inbox.markProcessed(inbox.consumerName, inbox.messageId, this.clock.now());
        });
        return {
          kind: "terminal_error",
          error: { code: err.code, message: err.message, retryable: false },
        };
      }
      throw err;
    }

    const correlationId = input.correlationId ?? newId();
    const now = this.clock.now();

    try {
      return await this.uow.transactional(async (repos) => {
        const claim = await this.claimInbox(repos, inbox, now);
        if (claim === "duplicate") return { kind: "duplicate" };
        if (claim === "in_flight") return { kind: "in_flight" };

        try {
          const result = await this.runFinancial(repos, input, prepared, correlationId, now);
          await repos.inbox.markProcessed(inbox.consumerName, inbox.messageId, this.clock.now());
          return { kind: "processed", result };
        } catch (err) {
          if (err instanceof ConcurrentWriteConflictError) throw err;
          if (err instanceof DomainError && !err.retryable) {
            await repos.inbox.markProcessed(inbox.consumerName, inbox.messageId, this.clock.now());
            return {
              kind: "terminal_error",
              error: { code: err.code, message: err.message, retryable: false },
            };
          }
          // Transient: roll back inbox claim with the TX
          throw err;
        }
      });
    } catch (err) {
      if (isRetryableWriteConflict(err) && attempt < 3) {
        this.metrics.recordLockConflict();
        return this.executeFromQueue(input, inbox, attempt + 1);
      }
      if (err instanceof ConcurrentWriteConflictError) {
        return {
          kind: "terminal_error",
          error: {
            code: FailureCode.IDEMPOTENCY_CONFLICT,
            message: "Concurrent write conflict exhausted retries",
            retryable: false,
          },
        };
      }
      if (err instanceof LockTimeoutError) {
        throw err;
      }
      throw err;
    }
  }

  private async prepare(input: ProcessWagerInput): Promise<{
    kind: WagerTransactionKind;
    money: Money;
    payloadHash: string;
  }> {
    if (!input.idempotencyKey?.trim()) {
      throw new DomainError(FailureCode.MISSING_IDEMPOTENCY_KEY, "Idempotency-Key is required");
    }

    const identity = await this.providers.resolve(input.providerId);
    if (!identity?.active) {
      throw new DomainError(FailureCode.VALIDATION_ERROR, "Unknown or inactive provider", {
        details: { providerId: input.providerId },
      });
    }

    const kind = KIND_MAP[input.kind];
    if (!kind) {
      throw new DomainError(FailureCode.VALIDATION_ERROR, `Invalid kind: ${input.kind}`);
    }
    if (kind === WagerTransactionKind.Opening) {
      throw new DomainError(
        FailureCode.KIND_NOT_ALLOWED,
        "OPENING cannot be submitted via API or queue",
      );
    }

    let money: Money;
    try {
      money = Money.from(input.money);
    } catch (err) {
      if (err instanceof DomainError) throw err;
      throw new DomainError(FailureCode.INVALID_MONEY, "Invalid money");
    }
    if (!money.isPositive()) {
      throw new DomainError(FailureCode.INVALID_MONEY, "Money amount must be positive");
    }

    const payloadHash = canonicalPayloadHash({
      providerId: input.providerId,
      externalTransactionId: input.externalTransactionId,
      walletId: input.walletId,
      playerId: input.playerId,
      roundId: input.roundId,
      gameId: input.gameId,
      kind: input.kind,
      money: money.toJSON(),
      ...(input.referenceExternalTransactionId !== undefined
        ? { referenceExternalTransactionId: input.referenceExternalTransactionId }
        : {}),
    });

    return { kind, money, payloadHash };
  }

  private async claimInbox(
    repos: TransactionalRepositories,
    inbox: InboxDedupContext,
    now: Date,
  ): Promise<"proceed" | "duplicate" | "in_flight"> {
    const message = InboxMessage.receive({
      messageId: inbox.messageId,
      consumerName: inbox.consumerName,
      payloadHash: inbox.payloadHash,
      receivedAt: now,
    });
    const result = await repos.inbox.tryReceive(message);
    if (result.created) return "proceed";

    const existing = result.existing;
    if (!existing) return "in_flight";
    // Hash mismatch always wins over duplicate/orphan paths (poison message with same id)
    if (existing.payloadHash !== inbox.payloadHash) {
      throw new DomainError(
        FailureCode.IDEMPOTENCY_CONFLICT,
        "Inbox messageId reused with a different payload",
        { details: { messageId: inbox.messageId } },
      );
    }
    if (existing.isProcessed()) return "duplicate";
    // Orphan claim (legacy multi-TX) or rare visibility race → reprocess idempotently
    return "proceed";
  }

  private async runFinancial(
    repos: TransactionalRepositories,
    input: ProcessWagerInput,
    prepared: { kind: WagerTransactionKind; money: Money; payloadHash: string },
    correlationId: string,
    now: Date,
  ): Promise<ProcessWagerResult> {
    const { kind, money, payloadHash } = prepared;

    const existing = await repos.transactions.findByIdempotencyKey(
      input.providerId,
      input.idempotencyKey,
    );

    if (existing) {
      if (!existing.matchesPayload(payloadHash)) {
        throw new DomainError(
          FailureCode.IDEMPOTENCY_CONFLICT,
          "Idempotency key reused with a different payload",
          {
            details: {
              providerId: input.providerId,
              idempotencyKey: input.idempotencyKey,
            },
          },
        );
      }
      return replayResult(existing);
    }

    const tx = WagerTransaction.create({
      id: newId(),
      providerId: input.providerId,
      externalTransactionId: input.externalTransactionId,
      idempotencyKey: input.idempotencyKey,
      payloadHash,
      walletId: input.walletId,
      playerId: input.playerId,
      roundId: input.roundId,
      gameId: input.gameId,
      kind,
      money,
      ...(input.referenceExternalTransactionId !== undefined
        ? { referenceExternalTransactionId: input.referenceExternalTransactionId }
        : {}),
      createdAt: now,
    });

    const needsLock = tx.affectsBalance();
    const wallet = needsLock
      ? await repos.wallets.lockByIdForUpdate(input.walletId)
      : await repos.wallets.findById(input.walletId);

    if (!wallet) {
      throw new WalletNotFoundError(input.walletId);
    }

    if (wallet.playerId !== input.playerId) {
      throw new DomainError(
        FailureCode.REFERENCE_MISMATCH,
        "playerId does not match wallet owner",
        { details: { walletId: input.walletId, playerId: input.playerId } },
      );
    }

    try {
      return await this.applyTransaction(repos, tx, wallet, now, correlationId);
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConcurrentWriteConflictError();
      }
      throw err;
    }
  }

  private async applyTransaction(
    repos: TransactionalRepositories,
    tx: WagerTransaction,
    wallet: Wallet,
    now: Date,
    correlationId: string,
  ): Promise<ProcessWagerResult> {
    // Currency mismatch → reject without mutating balance
    if (wallet.currency !== tx.money.currency) {
      tx.reject(FailureCode.WALLET_CURRENCY_MISMATCH, now, wallet.balance);
      await repos.transactions.insert(tx);
      await this.enqueueRejected(repos, tx, correlationId, now);
      return rejectedResult(tx);
    }

    let reference: WagerTransaction | undefined;

    if (
      tx.requiresReference() ||
      (tx.kind === WagerTransactionKind.Win && tx.referenceExternalTransactionId)
    ) {
      const resolved = await repos.transactions.findByExternalId(
        tx.providerId,
        tx.referenceExternalTransactionId!,
      );

      if (!resolved) {
        tx.markPendingReference(
          now,
          new Date(now.getTime() + REFERENCE_TTL_MS),
          new Date(now.getTime() + FIRST_REPROCESS_DELAY_MS),
        );
        await repos.transactions.insert(tx);
        await repos.outbox.enqueue(
          OutboxMessage.enqueue(
            WagerTransactionPendingReference.from(tx, {
              eventId: newId(),
              correlationId,
              causationId: tx.id,
              occurredAt: now,
            }),
            now,
          ),
        );
        return {
          transactionId: tx.id,
          status: tx.status,
          balance: null,
          idempotentReplay: false,
          httpHint: "accepted",
        };
      }

      const mismatch = validateReference(tx, resolved, wallet);
      if (mismatch) {
        tx.reject(mismatch, now, wallet.balance);
        await repos.transactions.insert(tx);
        await this.enqueueRejected(repos, tx, correlationId, now);
        return rejectedResult(tx);
      }

      if (tx.kind === WagerTransactionKind.Refund || tx.kind === WagerTransactionKind.Rollback) {
        const existingReversal = await repos.transactions.findProcessedReversalFor(resolved.id);
        if (existingReversal) {
          tx.reject(FailureCode.REFERENCE_ALREADY_REVERSED, now, wallet.balance);
          await repos.transactions.insert(tx);
          await this.enqueueRejected(repos, tx, correlationId, now);
          return rejectedResult(tx);
        }

        if (!tx.money.equals(resolved.money)) {
          tx.reject(FailureCode.REFERENCE_AMOUNT_MISMATCH, now, wallet.balance);
          await repos.transactions.insert(tx);
          await this.enqueueRejected(repos, tx, correlationId, now);
          return rejectedResult(tx);
        }
      }

      reference = resolved;
    }

    if (tx.kind === WagerTransactionKind.Loss) {
      tx.markProcessed(reference?.id, now, wallet.balance);
      await repos.transactions.insert(tx);
      await this.enqueueProcessed(repos, tx, correlationId, now);
      return processedResult(tx, wallet.balance, false);
    }

    let direction: LedgerDirection;
    let change: { before: Money; after: Money };

    try {
      direction = tx.ledgerDirectionFor(reference);
      change =
        direction === LedgerDirection.Debit
          ? wallet.debit(tx.money, now)
          : wallet.credit(tx.money, now);
    } catch (err) {
      if (err instanceof InsufficientBalanceError) {
        const code =
          tx.kind === WagerTransactionKind.Bet
            ? FailureCode.INSUFFICIENT_BALANCE
            : tx.kind === WagerTransactionKind.Refund
              ? FailureCode.REFUND_WOULD_OVERDRAW
              : tx.kind === WagerTransactionKind.Rollback
                ? FailureCode.ROLLBACK_WOULD_OVERDRAW
                : FailureCode.INSUFFICIENT_BALANCE;

        tx.reject(code, now, wallet.balance);
        await repos.transactions.insert(tx);
        await this.enqueueRejected(repos, tx, correlationId, now);
        return rejectedResult(tx);
      }
      if (err instanceof CurrencyMismatchError) {
        tx.reject(FailureCode.WALLET_CURRENCY_MISMATCH, now, wallet.balance);
        await repos.transactions.insert(tx);
        await this.enqueueRejected(repos, tx, correlationId, now);
        return rejectedResult(tx);
      }
      throw err;
    }

    tx.markProcessed(reference?.id, now, change.after);
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

    await repos.transactions.insert(tx);
    await repos.wallets.save(wallet);
    await repos.ledger.insert(entry);
    await this.enqueueProcessed(repos, tx, correlationId, now);
    await repos.outbox.enqueue(
      OutboxMessage.enqueue(
        WalletBalanceChanged.from(wallet, entry, {
          eventId: newId(),
          correlationId,
          causationId: tx.id,
          occurredAt: now,
        }),
        now,
      ),
    );

    return processedResult(tx, change.after, false);
  }

  private async enqueueProcessed(
    repos: TransactionalRepositories,
    tx: WagerTransaction,
    correlationId: string,
    now: Date,
  ): Promise<void> {
    await repos.outbox.enqueue(
      OutboxMessage.enqueue(
        WagerTransactionProcessed.from(tx, {
          eventId: newId(),
          correlationId,
          causationId: tx.id,
          occurredAt: now,
        }),
        now,
      ),
    );
  }

  private async enqueueRejected(
    repos: TransactionalRepositories,
    tx: WagerTransaction,
    correlationId: string,
    now: Date,
  ): Promise<void> {
    await repos.outbox.enqueue(
      OutboxMessage.enqueue(
        WagerTransactionRejected.from(tx, {
          eventId: newId(),
          correlationId,
          causationId: tx.id,
          occurredAt: now,
        }),
        now,
      ),
    );
  }
}

function validateReference(
  tx: WagerTransaction,
  reference: WagerTransaction,
  wallet: Wallet,
): FailureCode | null {
  if (reference.status !== WagerTransactionStatus.Processed) {
    // Not yet processed — treat as absent for ordering; caller already found it.
    // If reference exists but isn't PROCESSED, reject as mismatch/invalid.
    if (reference.status === WagerTransactionStatus.PendingReference) {
      return FailureCode.REFERENCE_NOT_FOUND;
    }
    // PENDING shouldn't happen for stored; REJECTED/FAILED can't be reversed
    return FailureCode.REFERENCE_INVALID_KIND;
  }

  if (
    reference.providerId !== tx.providerId ||
    reference.playerId !== tx.playerId ||
    reference.walletId !== tx.walletId ||
    reference.roundId !== tx.roundId ||
    reference.money.currency !== tx.money.currency ||
    reference.walletId !== wallet.id
  ) {
    return FailureCode.REFERENCE_MISMATCH;
  }

  if (!WagerTransaction.canReference(tx.kind, reference.kind)) {
    return FailureCode.REFERENCE_INVALID_KIND;
  }

  return null;
}

function replayResult(tx: WagerTransaction): ProcessWagerResult {
  if (tx.status === WagerTransactionStatus.PendingReference) {
    return {
      transactionId: tx.id,
      status: tx.status,
      balance: null,
      idempotentReplay: true,
      httpHint: "accepted",
    };
  }
  if (
    tx.status === WagerTransactionStatus.Rejected ||
    tx.status === WagerTransactionStatus.Failed
  ) {
    return {
      transactionId: tx.id,
      status: tx.status,
      balance: tx.resultBalance?.toJSON() ?? null,
      ...(tx.failureCode !== undefined ? { failureCode: tx.failureCode } : {}),
      idempotentReplay: true,
      httpHint: "rejected",
    };
  }
  return {
    transactionId: tx.id,
    status: tx.status,
    balance: tx.resultBalance?.toJSON() ?? null,
    idempotentReplay: true,
    httpHint: "ok",
  };
}

function processedResult(
  tx: WagerTransaction,
  balance: Money,
  replay: boolean,
): ProcessWagerResult {
  return {
    transactionId: tx.id,
    status: tx.status,
    balance: balance.toJSON(),
    idempotentReplay: replay,
    httpHint: "ok",
  };
}

function rejectedResult(tx: WagerTransaction): ProcessWagerResult {
  return {
    transactionId: tx.id,
    status: tx.status,
    balance: tx.resultBalance?.toJSON() ?? null,
    ...(tx.failureCode !== undefined ? { failureCode: tx.failureCode } : {}),
    idempotentReplay: false,
    httpHint: "rejected",
  };
}

/** Internal signal: unique race aborted the SQL TX — retry execute in a fresh TX. */
class ConcurrentWriteConflictError extends Error {
  constructor() {
    super("concurrent_write_conflict");
    this.name = "ConcurrentWriteConflictError";
  }
}

function isRetryableWriteConflict(err: unknown): boolean {
  return err instanceof ConcurrentWriteConflictError || err instanceof LockTimeoutError;
}

/** Marker used by HTTP layer to map WALLET_NOT_FOUND distinctly. */
export class WalletNotFoundError extends DomainError {
  constructor(walletId: string) {
    super(FailureCode.VALIDATION_ERROR, `Wallet not found: ${walletId}`, {
      details: { walletId, code: "WALLET_NOT_FOUND" },
    });
    this.name = "WalletNotFoundError";
  }
}
