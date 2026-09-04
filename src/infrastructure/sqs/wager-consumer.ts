import { canonicalPayloadHash } from "../../shared/canonical-hash";
import { newId } from "../../shared/id";
import type { ProcessWagerUseCase } from "../../wagering/application/use-cases/process-wager.use-case";
import { DomainError } from "../../wagering/domain";
import { logger } from "../observability/logger";
import {
  idempotencyDuplicatesTotal,
  sqsConsumedTotal,
  sqsRetriesTotal,
  wagerDurationSeconds,
  wagerProcessedTotal,
} from "../observability/metrics";
import type { SqsMessagingAdapter } from "./sqs.adapter";

const CONSUMER_NAME = "wager-consumer";

export interface WagerQueueEnvelope {
  messageId: string;
  type: string;
  occurredAt: string;
  data: {
    providerId: string;
    externalTransactionId: string;
    idempotencyKey?: string;
    playerId: string;
    walletId: string;
    roundId: string;
    gameId: string;
    kind: string;
    money: { amount: string; currency: string };
    referenceExternalTransactionId?: string;
  };
}

/**
 * SQS consumer for wager-transactions.fifo.
 * Inbox + ProcessWager + markProcessed share one SQL TX (ADR-017); ack only after commit.
 */
export class WagerSqsConsumer {
  private running = false;
  private readonly inFlight = new Set<Promise<void>>();
  private loopPromise: Promise<void> | null = null;

  constructor(
    private readonly sqs: SqsMessagingAdapter,
    private readonly processWager: ProcessWagerUseCase,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loopPromise = this.loop();
  }

  async stop(timeoutMs = 15_000): Promise<void> {
    this.running = false;
    await Promise.race([
      Promise.allSettled([...this.inFlight]),
      new Promise((r) => setTimeout(r, timeoutMs)),
    ]);
    await this.loopPromise?.catch(() => undefined);
  }

  /** Test/ops helper: receive and process one short poll batch. */
  async drainOnce(max = 5, waitSeconds = 1): Promise<number> {
    const messages = await this.sqs.receiveWagerMessages(max, waitSeconds);
    await Promise.all(messages.map((msg) => this.handle(msg)));
    return messages.length;
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        const messages = await this.sqs.receiveWagerMessages(5, 5);
        if (!this.running) {
          // Shutdown raced with long poll — release visibility so peers can reclaim ASAP
          await Promise.allSettled(
            messages.map((m) => this.sqs.releaseWagerVisibility(m.receiptHandle)),
          );
          break;
        }
        for (const msg of messages) {
          const task = this.handle(msg).finally(() => this.inFlight.delete(task));
          this.inFlight.add(task);
        }
      } catch (err) {
        logger.error({ msg: "sqs_receive_error", error: String(err) });
        await sleep(1000);
      }
    }
  }

  private async handle(msg: {
    body: string;
    receiptHandle: string;
    messageId: string;
    receiveCount: number;
  }): Promise<void> {
    let envelope: WagerQueueEnvelope;
    try {
      envelope = JSON.parse(msg.body) as WagerQueueEnvelope;
      if (envelope.type !== "WagerTransactionRequested" || !envelope.data) {
        logger.error({
          msg: "sqs_invalid_envelope",
          messageId: envelope.messageId ?? msg.messageId,
        });
        sqsConsumedTotal.inc({ result: "invalid" });
        await this.sqs.ackWager(msg.receiptHandle);
        return;
      }
    } catch {
      logger.error({ msg: "sqs_malformed_json", sqsMessageId: msg.messageId });
      sqsConsumedTotal.inc({ result: "malformed" });
      await this.sqs.ackWager(msg.receiptHandle);
      return;
    }

    const dedupId = envelope.messageId || msg.messageId;
    const data = envelope.data;
    const payloadHash = canonicalPayloadHash({
      providerId: data.providerId,
      externalTransactionId: data.externalTransactionId,
      walletId: data.walletId,
      playerId: data.playerId,
      roundId: data.roundId,
      gameId: data.gameId,
      kind: data.kind,
      money: data.money,
      ...(data.referenceExternalTransactionId !== undefined
        ? { referenceExternalTransactionId: data.referenceExternalTransactionId }
        : {}),
    });
    const logBase = {
      messageId: dedupId,
      walletId: data.walletId,
      providerId: data.providerId,
      receiveCount: msg.receiveCount,
    };

    if (msg.receiveCount > 1) {
      sqsRetriesTotal.inc();
    }

    try {
      const idempotencyKey =
        data.idempotencyKey ?? `${data.providerId}:${data.externalTransactionId}`;

      const started = process.hrtime.bigint();
      const outcome = await this.processWager.executeFromQueue(
        {
          providerId: data.providerId,
          externalTransactionId: data.externalTransactionId,
          idempotencyKey,
          playerId: data.playerId,
          walletId: data.walletId,
          roundId: data.roundId,
          gameId: data.gameId,
          kind: data.kind,
          money: data.money,
          ...(data.referenceExternalTransactionId !== undefined
            ? { referenceExternalTransactionId: data.referenceExternalTransactionId }
            : {}),
          correlationId: newId(),
        },
        {
          consumerName: CONSUMER_NAME,
          messageId: dedupId,
          payloadHash,
        },
      );
      const elapsed = Number(process.hrtime.bigint() - started) / 1_000_000_000;
      wagerDurationSeconds.observe({ kind: data.kind }, elapsed);

      if (outcome.kind === "in_flight") {
        sqsConsumedTotal.inc({ result: "in_flight" });
        const backoffRaw = Number(process.env["IN_FLIGHT_VISIBILITY_SECONDS"] ?? 5);
        const backoff = Number.isFinite(backoffRaw) && backoffRaw > 0 ? Math.floor(backoffRaw) : 5;
        logger.info({
          ...logBase,
          msg: "sqs_in_flight_defer",
          visibilitySeconds: backoff,
        });
        // Peer holds an uncommitted inbox claim (same-TX INSERT visible to ON CONFLICT).
        // Defer — do not release to 0 (race) and do not leave full 30s (slow recovery).
        // receiveCount still increments per ReceiveMessage; size maxReceiveCount vs backoff (ADR-023).
        try {
          await this.sqs.deferWagerVisibility(msg.receiptHandle, backoff);
        } catch (deferErr) {
          logger.error({
            ...logBase,
            msg: "sqs_in_flight_defer_failed",
            error: String(deferErr),
          });
        }
        return;
      }

      if (outcome.kind === "duplicate") {
        idempotencyDuplicatesTotal.inc({ source: "sqs_inbox" });
        await this.sqs.ackWager(msg.receiptHandle);
        sqsConsumedTotal.inc({ result: "duplicate" });
        logger.info({ ...logBase, msg: "sqs_duplicate_ack" });
        return;
      }

      if (outcome.kind === "terminal_error") {
        await this.sqs.ackWager(msg.receiptHandle);
        sqsConsumedTotal.inc({ result: "rejected" });
        logger.warn({
          ...logBase,
          msg: "sqs_terminal_error",
          code: outcome.error.code,
          error: outcome.error.message,
        });
        return;
      }

      const slowAckRaw = process.env["SLOW_ACK_MS"];
      const slowAck = slowAckRaw && slowAckRaw !== "undefined" ? Number(slowAckRaw) : 0;
      if (Number.isFinite(slowAck) && slowAck > 0) await sleep(slowAck);

      await this.sqs.ackWager(msg.receiptHandle);
      sqsConsumedTotal.inc({ result: "processed" });
      wagerProcessedTotal.inc({
        kind: data.kind,
        status: outcome.result.status,
      });
      if (outcome.result.idempotentReplay) {
        idempotencyDuplicatesTotal.inc({ source: "sqs_idempotency" });
      }
      logger.info({
        ...logBase,
        msg: "sqs_processed",
        transactionId: outcome.result.transactionId,
        status: outcome.result.status,
        idempotentReplay: outcome.result.idempotentReplay,
      });
    } catch (err) {
      if (err instanceof DomainError && !err.retryable) {
        await this.sqs.ackWager(msg.receiptHandle);
        sqsConsumedTotal.inc({ result: "rejected" });
        logger.warn({
          ...logBase,
          msg: "sqs_permanent_error_ack",
          code: err.code,
          error: err.message,
        });
        return;
      }
      sqsConsumedTotal.inc({ result: "transient" });
      logger.error({
        ...logBase,
        msg: "sqs_process_transient_error",
        error: String(err),
      });
      try {
        await this.sqs.releaseWagerVisibility(msg.receiptHandle);
      } catch (releaseErr) {
        logger.error({
          ...logBase,
          msg: "sqs_release_visibility_failed",
          error: String(releaseErr),
        });
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
