import type { WagerQueuePort } from "../../wagering/application/ports/wager-queue.port";
import { SqsMessagingAdapter, createSqsClient, loadSqsConfigFromEnv } from "./sqs.adapter";

export class SqsWagerQueueAdapter implements WagerQueuePort {
  private readonly sqs: SqsMessagingAdapter;

  constructor(sqs?: SqsMessagingAdapter) {
    if (sqs) {
      this.sqs = sqs;
      return;
    }
    const cfg = loadSqsConfigFromEnv();
    this.sqs = new SqsMessagingAdapter(createSqsClient(cfg), cfg.wagerQueueUrl, cfg.eventsQueueUrl);
  }

  enqueue(body: string, groupId: string, dedupId: string): Promise<void> {
    return this.sqs.enqueueWager(body, groupId, dedupId);
  }
}
