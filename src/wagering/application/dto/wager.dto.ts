export interface MoneyDto {
  amount: string;
  currency: string;
}

export interface ProcessWagerInput {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyDto;
  referenceExternalTransactionId?: string;
  correlationId?: string;
}

export interface ProcessWagerResult {
  transactionId: string;
  status: string;
  balance: MoneyDto | null;
  failureCode?: string;
  idempotentReplay: boolean;
  httpHint: "ok" | "accepted" | "rejected" | "conflict" | "not_found";
}

/** Persistent inbox claim for SQS — must run in the same SQL TX as ProcessWager. */
export interface InboxDedupContext {
  consumerName: string;
  messageId: string;
  payloadHash: string;
}

export type QueueProcessOutcome =
  | { kind: "processed"; result: ProcessWagerResult }
  | { kind: "duplicate" }
  | { kind: "in_flight" }
  | { kind: "terminal_error"; error: { code: string; message: string; retryable: boolean } };
