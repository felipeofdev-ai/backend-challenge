import {
  ChangeMessageVisibilityCommand,
  CreateQueueCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SQSClient,
  SendMessageCommand,
  SetQueueAttributesCommand,
} from "@aws-sdk/client-sqs";

export interface SqsConfig {
  region: string;
  endpoint?: string;
  accessKeyId: string;
  secretAccessKey: string;
  wagerQueueUrl: string;
  eventsQueueUrl: string;
}

export function createSqsClient(cfg: SqsConfig): SQSClient {
  return new SQSClient({
    region: cfg.region,
    ...(cfg.endpoint ? { endpoint: cfg.endpoint } : {}),
    credentials: {
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
    },
  });
}

export function loadSqsConfigFromEnv(): SqsConfig {
  const endpoint = process.env["AWS_ENDPOINT_URL"];
  return {
    region: process.env["AWS_REGION"] ?? "us-east-1",
    ...(endpoint !== undefined && endpoint !== "" ? { endpoint } : {}),
    accessKeyId: process.env["AWS_ACCESS_KEY_ID"] ?? "test",
    secretAccessKey: process.env["AWS_SECRET_ACCESS_KEY"] ?? "test",
    wagerQueueUrl:
      process.env["SQS_WAGER_QUEUE_URL"] ??
      "http://localhost:4566/000000000000/wager-transactions.fifo",
    eventsQueueUrl:
      process.env["SQS_EVENTS_QUEUE_URL"] ?? "http://localhost:4566/000000000000/wager-events.fifo",
  };
}

export class SqsMessagingAdapter {
  constructor(
    private readonly client: SQSClient,
    private readonly wagerQueueUrl: string,
    private readonly eventsQueueUrl: string,
  ) {}

  async isReachable(): Promise<boolean> {
    try {
      await this.client.send(
        new GetQueueAttributesCommand({
          QueueUrl: this.wagerQueueUrl,
          AttributeNames: ["ApproximateNumberOfMessages"],
        }),
      );
      return true;
    } catch {
      return false;
    }
  }

  async receiveWagerMessages(
    max = 5,
    waitSeconds = 10,
  ): Promise<
    Array<{
      body: string;
      receiptHandle: string;
      messageId: string;
      receiveCount: number;
    }>
  > {
    const res = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: this.wagerQueueUrl,
        MaxNumberOfMessages: max,
        WaitTimeSeconds: waitSeconds,
        VisibilityTimeout: 30,
        AttributeNames: ["All"],
        MessageAttributeNames: ["All"],
      }),
    );
    return (res.Messages ?? []).map((m) => ({
      body: m.Body ?? "",
      receiptHandle: m.ReceiptHandle ?? "",
      messageId: m.MessageId ?? "",
      receiveCount: Number(m.Attributes?.["ApproximateReceiveCount"] ?? "1"),
    }));
  }

  async ackWager(receiptHandle: string): Promise<void> {
    await this.client.send(
      new DeleteMessageCommand({
        QueueUrl: this.wagerQueueUrl,
        ReceiptHandle: receiptHandle,
      }),
    );
  }

  /** VisibilityTimeout=0 makes the message immediately available for redelivery. */
  async releaseWagerVisibility(receiptHandle: string): Promise<void> {
    await this.deferWagerVisibility(receiptHandle, 0);
  }

  /**
   * Postpone redelivery without ack. Used for in_flight (peer holds uncommitted inbox claim)
   * so we do not thundering-herd at VisibilityTimeout=0, nor burn the full 30s receive window.
   */
  async deferWagerVisibility(receiptHandle: string, timeoutSeconds: number): Promise<void> {
    await this.client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: this.wagerQueueUrl,
        ReceiptHandle: receiptHandle,
        VisibilityTimeout: timeoutSeconds,
      }),
    );
  }

  async publishEvent(body: string, groupId: string, deduplicationId: string): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.eventsQueueUrl,
        MessageBody: body,
        MessageGroupId: groupId,
        MessageDeduplicationId: deduplicationId,
      }),
    );
  }

  async enqueueWager(body: string, groupId: string, deduplicationId: string): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.wagerQueueUrl,
        MessageBody: body,
        MessageGroupId: groupId,
        MessageDeduplicationId: deduplicationId,
      }),
    );
  }

  async resolveQueueUrl(name: string): Promise<string | null> {
    try {
      const res = await this.client.send(new GetQueueUrlCommand({ QueueName: name }));
      return res.QueueUrl ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Creates (or returns existing) FIFO queue for isolated integration tests.
   * Avoids races with a long-running local worker on the shared wager queue.
   */
  async ensureFifoQueue(
    name: string,
    options?: { dlqName?: string; maxReceiveCount?: number },
  ): Promise<{
    queueUrl: string;
    dlqUrl?: string;
  }> {
    let dlqUrl: string | undefined;
    let dlqArn: string | undefined;
    if (options?.dlqName) {
      const existingDlq = await this.resolveQueueUrl(options.dlqName);
      if (existingDlq) {
        dlqUrl = existingDlq;
      } else {
        const dlqRes = await this.client.send(
          new CreateQueueCommand({
            QueueName: options.dlqName,
            Attributes: {
              FifoQueue: "true",
              ContentBasedDeduplication: "false",
            },
          }),
        );
        dlqUrl = dlqRes.QueueUrl;
      }
      if (dlqUrl) {
        const attrs = await this.client.send(
          new GetQueueAttributesCommand({
            QueueUrl: dlqUrl,
            AttributeNames: ["QueueArn"],
          }),
        );
        dlqArn = attrs.Attributes?.["QueueArn"];
      }
    }

    const existing = await this.resolveQueueUrl(name);
    if (existing) {
      if (dlqArn && options?.maxReceiveCount) {
        await this.client.send(
          new SetQueueAttributesCommand({
            QueueUrl: existing,
            Attributes: {
              RedrivePolicy: JSON.stringify({
                deadLetterTargetArn: dlqArn,
                maxReceiveCount: String(options.maxReceiveCount),
              }),
              VisibilityTimeout: "5",
            },
          }),
        );
      }
      return { queueUrl: existing, ...(dlqUrl !== undefined ? { dlqUrl } : {}) };
    }

    const attributes: Record<string, string> = {
      FifoQueue: "true",
      ContentBasedDeduplication: "false",
      VisibilityTimeout: "5",
      MessageRetentionPeriod: "3600",
    };
    if (dlqArn && options?.maxReceiveCount) {
      attributes["RedrivePolicy"] = JSON.stringify({
        deadLetterTargetArn: dlqArn,
        maxReceiveCount: String(options.maxReceiveCount),
      });
    }

    const res = await this.client.send(
      new CreateQueueCommand({
        QueueName: name,
        Attributes: attributes,
      }),
    );
    const url = res.QueueUrl;
    if (!url) throw new Error(`CreateQueue returned no URL for ${name}`);
    return { queueUrl: url, ...(dlqUrl !== undefined ? { dlqUrl } : {}) };
  }

  async receiveFromQueue(
    queueUrl: string,
    max = 5,
    waitSeconds = 1,
  ): Promise<
    Array<{
      body: string;
      receiptHandle: string;
      messageId: string;
      receiveCount: number;
    }>
  > {
    const res = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: max,
        WaitTimeSeconds: waitSeconds,
        VisibilityTimeout: 2,
        AttributeNames: ["All"],
      }),
    );
    return (res.Messages ?? []).map((m) => ({
      body: m.Body ?? "",
      receiptHandle: m.ReceiptHandle ?? "",
      messageId: m.MessageId ?? "",
      receiveCount: Number(m.Attributes?.["ApproximateReceiveCount"] ?? "1"),
    }));
  }

  async changeMessageVisibility(
    queueUrl: string,
    receiptHandle: string,
    timeoutSeconds: number,
  ): Promise<void> {
    await this.client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: queueUrl,
        ReceiptHandle: receiptHandle,
        VisibilityTimeout: timeoutSeconds,
      }),
    );
  }

  async deleteMessage(queueUrl: string, receiptHandle: string): Promise<void> {
    await this.client.send(
      new DeleteMessageCommand({
        QueueUrl: queueUrl,
        ReceiptHandle: receiptHandle,
      }),
    );
  }

  async deleteQueue(queueUrl: string): Promise<void> {
    await this.client.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
  }
}
