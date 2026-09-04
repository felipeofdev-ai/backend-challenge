import { Injectable } from "@nestjs/common";
import { newId } from "../../../shared/id";
import { Money } from "../../domain/value-objects/money";
import type { MoneyDto } from "../dto/wallet.dto";
import type { ClockPort, UnitOfWorkPort } from "../ports/repositories";
import { WalletNotFoundError } from "./process-wager.use-case";

export interface ReconciliationResult {
  id: string;
  walletId: string;
  storedBalance: MoneyDto;
  calculatedBalance: MoneyDto;
  difference: MoneyDto;
  consistent: boolean;
  checkedEntries: number;
  createdAt: string;
}

@Injectable()
export class ReconcileWalletUseCase {
  constructor(
    private readonly uow: UnitOfWorkPort,
    private readonly clock: ClockPort,
  ) {}

  async execute(walletId: string): Promise<ReconciliationResult> {
    return this.uow.transactional(async (repos) => {
      const wallet = await repos.wallets.findById(walletId);
      if (!wallet) throw new WalletNotFoundError(walletId);

      const checkedEntries = await repos.ledger.countByWalletId(walletId);
      const sums = await repos.ledger.sumBalanceFromLedger(walletId);
      const credit = Money.from({ amount: sums.credit, currency: wallet.currency });
      const debit = Money.from({ amount: sums.debit, currency: wallet.currency });
      const calculated = credit.subtract(debit);
      const stored = wallet.balance;
      const difference = stored.subtract(calculated);
      const consistent = stored.equals(calculated);
      const now = this.clock.now();
      const id = newId();

      await repos.reconciliation.insert({
        id,
        walletId,
        storedBalance: stored.toPersistence(),
        calculatedBalance: calculated.toPersistence(),
        difference: difference.toPersistence(),
        consistent,
        checkedEntries,
        createdAt: now,
      });

      return {
        id,
        walletId,
        storedBalance: stored.toJSON(),
        calculatedBalance: calculated.toJSON(),
        difference: difference.toJSON(),
        consistent,
        checkedEntries,
        createdAt: now.toISOString(),
      };
    });
  }
}
