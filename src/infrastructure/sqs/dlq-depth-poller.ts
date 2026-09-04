/**
 * Polls SQS DLQ depth into Prometheus gauge.
 */
import { GetQueueAttributesCommand, type SQSClient } from "@aws-sdk/client-sqs";
import { logger } from "../observability/logger";
import { sqsDlqDepth } from "../observability/metrics";

export class DlqDepthPoller {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly client: SQSClient,
    private readonly dlqUrl: string,
    private readonly intervalMs = 15_000,
  ) {}

  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    try {
      const res = await this.client.send(
        new GetQueueAttributesCommand({
          QueueUrl: this.dlqUrl,
          AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible"],
        }),
      );
      const visible = Number(res.Attributes?.["ApproximateNumberOfMessages"] ?? 0);
      const notVisible = Number(res.Attributes?.["ApproximateNumberOfMessagesNotVisible"] ?? 0);
      sqsDlqDepth.set(visible + notVisible);
    } catch (err) {
      logger.warn({ msg: "dlq_depth_poll_failed", error: String(err) });
    }
  }
}
