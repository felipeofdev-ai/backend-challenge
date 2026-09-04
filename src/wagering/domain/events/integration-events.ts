import {
  IntegrationEvent,
  type IntegrationEventProps,
} from "../../../messaging/domain/integration-event";
import type { WagerTransaction } from "../entities/wager-transaction";
import type { Wallet } from "../entities/wallet";
import type { WalletLedgerEntry } from "../entities/wallet-ledger-entry";
import { FailureCode, LedgerDirection, WagerTransactionKind } from "../enums";
import type { MoneyProps } from "../value-objects/money";

export interface EventContext {
  eventId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: Date;
}

function toEventProps<T>(
  aggregateId: string,
  ctx: EventContext,
  data: T,
): IntegrationEventProps<T> {
  return {
    eventId: ctx.eventId,
    aggregateId,
    correlationId: ctx.correlationId,
    occurredAt: ctx.occurredAt,
    data,
    ...(ctx.causationId !== undefined ? { causationId: ctx.causationId } : {}),
  };
}

export interface WagerTransactionProcessedData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  balanceAfter: MoneyProps;
  processedAt: string;
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = "WagerTransactionProcessed";
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WagerTransactionProcessedData>) {
    super(props);
  }

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    if (!tx.resultBalance || !tx.processedAt) {
      throw new Error("Processed event requires resultBalance and processedAt");
    }
    return new WagerTransactionProcessed(
      toEventProps(tx.id, ctx, {
        transactionId: tx.id,
        providerId: tx.providerId,
        externalTransactionId: tx.externalTransactionId,
        walletId: tx.walletId,
        playerId: tx.playerId,
        roundId: tx.roundId,
        kind: tx.kind,
        money: tx.money.toJSON(),
        balanceAfter: tx.resultBalance.toJSON(),
        processedAt: tx.processedAt.toISOString(),
      }),
    );
  }
}

export interface WagerTransactionRejectedData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  kind: WagerTransactionKind;
  failureCode: FailureCode;
  attemptedMoney: MoneyProps;
  rejectedAt: string;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = "WagerTransactionRejected";
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WagerTransactionRejectedData>) {
    super(props);
  }

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    if (!tx.failureCode || !tx.processedAt) {
      throw new Error("Rejected event requires failureCode and processedAt");
    }
    return new WagerTransactionRejected(
      toEventProps(tx.id, ctx, {
        transactionId: tx.id,
        providerId: tx.providerId,
        externalTransactionId: tx.externalTransactionId,
        walletId: tx.walletId,
        playerId: tx.playerId,
        kind: tx.kind,
        failureCode: tx.failureCode,
        attemptedMoney: tx.money.toJSON(),
        rejectedAt: tx.processedAt.toISOString(),
      }),
    );
  }
}

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = "WalletBalanceChanged";
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WalletBalanceChangedData>) {
    super(props);
  }

  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext): WalletBalanceChanged {
    return new WalletBalanceChanged(
      toEventProps(wallet.id, ctx, {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: wallet.version,
      }),
    );
  }
}

export interface WagerTransactionPendingReferenceData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  referenceExternalTransactionId: string;
  walletId: string;
  playerId: string;
  kind: WagerTransactionKind;
  attempt: number;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = "WagerTransactionPendingReference";
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WagerTransactionPendingReferenceData>) {
    super(props);
  }

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    if (!tx.referenceExternalTransactionId) {
      throw new Error("PendingReference event requires referenceExternalTransactionId");
    }
    return new WagerTransactionPendingReference(
      toEventProps(tx.id, ctx, {
        transactionId: tx.id,
        providerId: tx.providerId,
        externalTransactionId: tx.externalTransactionId,
        referenceExternalTransactionId: tx.referenceExternalTransactionId,
        walletId: tx.walletId,
        playerId: tx.playerId,
        kind: tx.kind,
        attempt: tx.referenceAttempts,
      }),
    );
  }
}

export interface WalletOpenedData {
  walletId: string;
  playerId: string;
  currency: string;
  initialBalance: MoneyProps;
}

export class WalletOpened extends IntegrationEvent<WalletOpenedData> {
  readonly eventType = "WalletOpened";
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WalletOpenedData>) {
    super(props);
  }

  static from(wallet: Wallet, ctx: EventContext): WalletOpened {
    return new WalletOpened(
      toEventProps(wallet.id, ctx, {
        walletId: wallet.id,
        playerId: wallet.playerId,
        currency: wallet.currency,
        initialBalance: wallet.balance.toJSON(),
      }),
    );
  }
}
