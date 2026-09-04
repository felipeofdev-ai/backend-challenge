/**
 * Opt-in HTTP → SQS enqueue (ADR-020).
 * Default evaluation path remains synchronous ProcessWager (challenge §9 example).
 */
import { createHash } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { newId } from "../../../shared/id";
import { FailureCode } from "../../domain/enums";
import { DomainError } from "../../domain/errors";
import { Money } from "../../domain/value-objects/money";
import type { ProcessWagerInput } from "../dto/wager.dto";
import type { WagerQueuePort } from "../ports/wager-queue.port";

const ALLOWED_KINDS = new Set(["BET", "WIN", "LOSS", "REFUND", "ROLLBACK"]);

export type EnqueueWagerResult = {
  status: "PENDING";
  messageId: string;
  idempotencyKey: string;
  httpHint: "accepted";
  balance: null;
  idempotentReplay: false;
};

@Injectable()
export class EnqueueWagerUseCase {
  constructor(private readonly queue: WagerQueuePort) {}

  async execute(input: ProcessWagerInput): Promise<EnqueueWagerResult> {
    if (!input.idempotencyKey?.trim()) {
      throw new DomainError(FailureCode.MISSING_IDEMPOTENCY_KEY, "Idempotency-Key is required");
    }
    if (!ALLOWED_KINDS.has(input.kind)) {
      throw new DomainError(FailureCode.VALIDATION_ERROR, `Invalid kind: ${input.kind}`);
    }
    // Fail-fast money validation without touching the wallet (no financial effect here)
    Money.from(input.money);

    const messageId = newId();
    const occurredAt = new Date().toISOString();
    const body = JSON.stringify({
      messageId,
      type: "WagerTransactionRequested",
      occurredAt,
      data: {
        providerId: input.providerId,
        externalTransactionId: input.externalTransactionId,
        idempotencyKey: input.idempotencyKey,
        playerId: input.playerId,
        walletId: input.walletId,
        roundId: input.roundId,
        gameId: input.gameId,
        kind: input.kind,
        money: input.money,
        ...(input.referenceExternalTransactionId !== undefined
          ? { referenceExternalTransactionId: input.referenceExternalTransactionId }
          : {}),
        ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
      },
    });

    // FIFO MessageDeduplicationId = stable business key (not random) for at-least-once HTTP retries
    const dedup = createHash("sha256")
      .update(input.idempotencyKey, "utf8")
      .digest("hex")
      .slice(0, 128);
    await this.queue.enqueue(body, input.walletId, dedup);

    return {
      status: "PENDING",
      messageId,
      idempotencyKey: input.idempotencyKey,
      httpHint: "accepted",
      balance: null,
      idempotentReplay: false,
    };
  }
}
