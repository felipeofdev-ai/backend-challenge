import { Injectable } from "@nestjs/common";
import { DomainError, FailureCode } from "../../domain";
import type { WagerTransaction } from "../../domain/entities/wager-transaction";
import type { LedgerPage, WalletView } from "../dto/wallet.dto";
import type { UnitOfWorkPort } from "../ports/repositories";
import { WalletNotFoundError } from "./process-wager.use-case";

@Injectable()
export class GetWalletUseCase {
  constructor(private readonly uow: UnitOfWorkPort) {}

  async execute(walletId: string): Promise<WalletView> {
    return this.uow.transactional(async (repos) => {
      const wallet = await repos.wallets.findById(walletId);
      if (!wallet) throw new WalletNotFoundError(walletId);
      return {
        id: wallet.id,
        playerId: wallet.playerId,
        balance: wallet.balance.toJSON(),
        version: wallet.version,
        createdAt: wallet.createdAt.toISOString(),
        updatedAt: wallet.updatedAt.toISOString(),
      };
    });
  }
}

@Injectable()
export class GetLedgerUseCase {
  constructor(private readonly uow: UnitOfWorkPort) {}

  async execute(
    walletId: string,
    options: { cursor?: string; limit?: number },
  ): Promise<LedgerPage> {
    if (options.limit !== undefined && (!Number.isFinite(options.limit) || options.limit < 1)) {
      throw new DomainError(FailureCode.VALIDATION_ERROR, "Invalid limit");
    }
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    let afterCreatedAt: Date | undefined;
    let afterId: string | undefined;

    if (options.cursor) {
      try {
        const raw = Buffer.from(options.cursor, "base64url").toString("utf8");
        const parsed = JSON.parse(raw) as { createdAt: string; id: string };
        afterCreatedAt = new Date(parsed.createdAt);
        afterId = parsed.id;
      } catch {
        throw new DomainError(FailureCode.VALIDATION_ERROR, "Invalid cursor");
      }
    }

    return this.uow.transactional(async (repos) => {
      const wallet = await repos.wallets.findById(walletId);
      if (!wallet) throw new WalletNotFoundError(walletId);

      const rows = await repos.ledger.findByWalletId(walletId, {
        limit: limit + 1,
        ...(afterCreatedAt !== undefined ? { afterCreatedAt } : {}),
        ...(afterId !== undefined ? { afterId } : {}),
      });

      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      const nextCursor =
        rows.length > limit && last
          ? Buffer.from(
              JSON.stringify({ createdAt: last.createdAt.toISOString(), id: last.id }),
              "utf8",
            ).toString("base64url")
          : null;

      return {
        entries: page.map((e) => ({
          id: e.id,
          transactionId: e.transactionId,
          direction: e.direction,
          money: e.money.toJSON(),
          balanceBefore: e.balanceBefore.toJSON(),
          balanceAfter: e.balanceAfter.toJSON(),
          createdAt: e.createdAt.toISOString(),
        })),
        nextCursor,
        limit,
      };
    });
  }
}

@Injectable()
export class GetTransactionUseCase {
  constructor(private readonly uow: UnitOfWorkPort) {}

  async byId(transactionId: string) {
    return this.uow.transactional(async (repos) => {
      const tx = await repos.transactions.findById(transactionId);
      if (!tx) {
        throw new DomainError(FailureCode.VALIDATION_ERROR, "Transaction not found", {
          details: { code: "TRANSACTION_NOT_FOUND" },
        });
      }
      return toTransactionView(tx);
    });
  }

  async byExternal(providerId: string, externalTransactionId: string) {
    return this.uow.transactional(async (repos) => {
      const tx = await repos.transactions.findByExternalId(providerId, externalTransactionId);
      if (!tx) {
        throw new DomainError(FailureCode.VALIDATION_ERROR, "Transaction not found", {
          details: { code: "TRANSACTION_NOT_FOUND" },
        });
      }
      return toTransactionView(tx);
    });
  }
}

function toTransactionView(tx: WagerTransaction) {
  return {
    transactionId: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    status: tx.status,
    money: tx.money.toJSON(),
    ...(tx.referenceExternalTransactionId !== undefined
      ? { referenceExternalTransactionId: tx.referenceExternalTransactionId }
      : {}),
    ...(tx.failureCode !== undefined ? { failureCode: tx.failureCode } : {}),
    ...(tx.resultBalance !== undefined ? { balance: tx.resultBalance.toJSON() } : {}),
    ...(tx.processedAt !== undefined ? { processedAt: tx.processedAt.toISOString() } : {}),
    createdAt: tx.createdAt.toISOString(),
  };
}
