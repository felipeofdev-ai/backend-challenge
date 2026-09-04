import type { IntegrationEvent } from "./integration-event";

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  version: number;
  payload: Readonly<Record<string, unknown>>;
  correlationId: string;
  causationId?: string;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date;
  publishedAt?: Date;
  createdAt: Date;
}

/**
 * Transactional outbox row. enqueue() from an IntegrationEvent.
 * Backoff: 1s * 2^n capped at 5 minutes, ±20% jitter applied by scheduleRetry.
 */
export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly version: number,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly correlationId: string,
    public readonly causationId: string | undefined,
    public readonly occurredAt: Date,
    public readonly createdAt: Date,
    private _attempts: number,
    private _nextAttemptAt: Date | undefined,
    private _publishedAt: Date | undefined,
  ) {}

  static enqueue(event: IntegrationEvent<unknown>, createdAt: Date = new Date()): OutboxMessage {
    const envelope = event.toJSON();
    return new OutboxMessage(
      event.eventId,
      event.aggregateId,
      event.eventType,
      event.version,
      envelope as unknown as Readonly<Record<string, unknown>>,
      event.correlationId,
      event.causationId,
      event.occurredAt,
      createdAt,
      0,
      createdAt,
      undefined,
    );
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      state.version,
      state.payload,
      state.correlationId,
      state.causationId,
      state.occurredAt,
      state.createdAt,
      state.attempts,
      state.nextAttemptAt,
      state.publishedAt,
    );
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }

  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    if (!this.isPending()) return false;
    if (this._nextAttemptAt === undefined) return true;
    return this._nextAttemptAt.getTime() <= now.getTime();
  }

  markPublished(at: Date): void {
    this._publishedAt = at;
  }

  scheduleRetry(now: Date): void {
    this._attempts += 1;
    const baseMs = Math.min(1000 * 2 ** Math.min(this._attempts, 8), 5 * 60 * 1000);
    const jitter = baseMs * (0.8 + Math.random() * 0.4);
    this._nextAttemptAt = new Date(now.getTime() + jitter);
  }

  /** Temporary claim lease so concurrent publishers skip this row until lease expires. */
  leaseUntil(until: Date): void {
    this._nextAttemptAt = until;
  }
}
