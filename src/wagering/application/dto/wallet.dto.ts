export interface MoneyDto {
  amount: string;
  currency: string;
}

export interface CreateWalletInput {
  playerId: string;
  initialBalance: MoneyDto;
}

export interface CreateWalletResult {
  id: string;
  playerId: string;
  balance: MoneyDto;
  version: number;
}

export interface WalletView {
  id: string;
  playerId: string;
  balance: MoneyDto;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface LedgerEntryView {
  id: string;
  transactionId: string;
  direction: string;
  money: MoneyDto;
  balanceBefore: MoneyDto;
  balanceAfter: MoneyDto;
  createdAt: string;
}

export interface LedgerPage {
  entries: LedgerEntryView[];
  nextCursor: string | null;
  limit: number;
}
