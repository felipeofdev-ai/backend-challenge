import { Injectable } from "@nestjs/common";
import { OutboxMessage } from "../../../messaging/domain/outbox-message";
import { canonicalPayloadHash } from "../../../shared/canonical-hash";
import { newId } from "../../../shared/id";
import { isUniqueViolation } from "../../../shared/unique-violation";
import { WagerTransaction } from "../../domain/entities/wager-transaction";
import { Wallet } from "../../domain/entities/wallet";
import { WalletLedgerEntry } from "../../domain/entities/wallet-ledger-entry";
import { FailureCode, LedgerDirection, WagerTransactionKind } from "../../domain/enums";
import { DomainError, WalletAlreadyExistsError } from "../../domain/errors";
import { WalletBalanceChanged, WalletOpened } from "../../domain/events/integration-events";
import { Money } from "../../domain/value-objects/money";
import type { CreateWalletInput, CreateWalletResult } from "../dto/wallet.dto";
import type { ClockPort, UnitOfWorkPort } from "../ports/repositories";

@Injectable()
export class CreateWalletUseCase {
  constructor(
    private readonly uow: UnitOfWorkPort,
    private readonly clock: ClockPort,
  ) {}

  async execute(input: CreateWalletInput): Promise<CreateWalletResult> {
    let money: Money;
    try {
      money = Money.from(input.initialBalance);
    } catch (err) {
      if (err instanceof DomainError) throw err;
      throw new DomainError(FailureCode.INVALID_MONEY, "Invalid initialBalance");
    }

    const now = this.clock.now();
    const walletId = newId();
    const correlationId = newId();

    return this.uow.transactional(async (repos) => {
      const wallet = Wallet.open({
        id: walletId,
        playerId: input.playerId,
        initialBalance: money,
        now,
      });

      try {
        await repos.wallets.insert(wallet);
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new WalletAlreadyExistsError(input.playerId, money.currency);
        }
        throw err;
      }

      if (money.isPositive()) {
        const opening = WagerTransaction.create({
          id: newId(),
          providerId: "system",
          externalTransactionId: `opening:${walletId}`,
          idempotencyKey: `system:opening:${walletId}`,
          payloadHash: canonicalPayloadHash({
            providerId: "system",
            externalTransactionId: `opening:${walletId}`,
            walletId,
            playerId: input.playerId,
            roundId: "opening",
            gameId: "system",
            kind: WagerTransactionKind.Opening,
            money: money.toJSON(),
          }),
          walletId,
          playerId: input.playerId,
          roundId: "opening",
          gameId: "system",
          kind: WagerTransactionKind.Opening,
          money,
          allowOpening: true,
          createdAt: now,
        });

        const change = { before: Money.zero(money.currency), after: money };
        opening.markProcessed(undefined, now, money);

        const entry = WalletLedgerEntry.create({
          id: newId(),
          walletId,
          transactionId: opening.id,
          direction: LedgerDirection.Credit,
          money,
          balanceBefore: change.before,
          balanceAfter: change.after,
          createdAt: now,
        });

        await repos.transactions.insert(opening);
        await repos.ledger.insert(entry);

        const ctx = {
          eventId: newId(),
          correlationId,
          causationId: opening.id,
          occurredAt: now,
        };
        await repos.outbox.enqueue(
          OutboxMessage.enqueue(WalletOpened.from(wallet, { ...ctx, eventId: newId() }), now),
        );
        await repos.outbox.enqueue(
          OutboxMessage.enqueue(
            WalletBalanceChanged.from(wallet, entry, { ...ctx, eventId: newId() }),
            now,
          ),
        );
      } else {
        await repos.outbox.enqueue(
          OutboxMessage.enqueue(
            WalletOpened.from(wallet, {
              eventId: newId(),
              correlationId,
              occurredAt: now,
            }),
            now,
          ),
        );
      }

      return {
        id: wallet.id,
        playerId: wallet.playerId,
        balance: wallet.balance.toJSON(),
        version: wallet.version,
      };
    });
  }
}
