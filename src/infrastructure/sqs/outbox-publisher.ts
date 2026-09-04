import type { ClockPort, UnitOfWorkPort } from "../../wagering/application/ports/repositories";
import { logger } from "../observability/logger";
import {
  outboxLagMessages,
  outboxPublishErrorsTotal,
  outboxPublishedTotal,
} from "../observability/metrics";
import type { SqsMessagingAdapter } from "./sqs.adapter";

/**
 * Publishes pending outbox rows to wager-events.fifo.
 * Concurrent publishers are safe via FOR UPDATE SKIP LOCKED.
 */
export class OutboxPublisher {
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly uow: UnitOfWorkPort,
    private readonly sqs: SqsMessagingAdapter,
    private readonly clock: ClockPort,
    private readonly intervalMs = Number(process.env["OUTBOX_POLL_INTERVAL_MS"] ?? 1000),
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.tick();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
  }

  private async tick(): Promise<void> {
    if (!this.running) return;
    try {
      await this.publishBatch(50);
    } catch (err) {
      logger.error({ msg: "outbox_tick_error", error: String(err) });
    }
    if (this.running) {
      this.timer = setTimeout(() => void this.tick(), this.intervalMs);
    }
  }

  async publishBatch(limit: number): Promise<number> {
    const now = this.clock.now();
    const due = await this.uow.transactional(async (repos) => {
      const claimed = await repos.outbox.claimDue(now, limit);
      const lag = await repos.outbox.countUnpublished();
      outboxLagMessages.set(lag);
      return claimed;
    });
    let published = 0;

    for (const message of due) {
      try {
        await this.sqs.publishEvent(
          JSON.stringify(message.payload),
          message.aggregateId,
          message.id,
        );
        await this.uow.transactional(async (repos) => {
          await repos.outbox.markPublished(message.id, this.clock.now());
        });
        published += 1;
        outboxPublishedTotal.inc();
      } catch (err) {
        outboxPublishErrorsTotal.inc();
        logger.error({
          msg: "outbox_publish_failed",
          eventId: message.id,
          error: String(err),
        });
        await this.uow.transactional(async (repos) => {
          await repos.outbox.scheduleRetry(message, this.clock.now());
        });
      }
    }
    return published;
  }
}
