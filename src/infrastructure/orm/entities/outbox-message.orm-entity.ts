import { Entity, Index, PrimaryKey, Property } from "@mikro-orm/core";

@Entity({ tableName: "outbox_messages" })
@Index({ properties: ["nextAttemptAt"], name: "ix_outbox_pending" })
export class OutboxMessageOrmEntity {
  @PrimaryKey({ type: "uuid" })
  id!: string;

  @Property({ fieldName: "aggregate_id", type: "uuid" })
  aggregateId!: string;

  @Property({ fieldName: "event_type", type: "string", length: 64 })
  eventType!: string;

  @Property({ type: "integer" })
  version!: number;

  @Property({ type: "json" })
  payload!: Record<string, unknown>;

  @Property({ fieldName: "correlation_id", type: "uuid" })
  correlationId!: string;

  @Property({ fieldName: "causation_id", type: "uuid", nullable: true })
  causationId?: string | null;

  @Property({ fieldName: "occurred_at", type: "timestamptz" })
  occurredAt!: Date;

  @Property({ type: "integer" })
  attempts = 0;

  @Property({ fieldName: "next_attempt_at", type: "timestamptz" })
  nextAttemptAt!: Date;

  @Property({ fieldName: "published_at", type: "timestamptz", nullable: true })
  publishedAt?: Date | null;

  @Property({ fieldName: "created_at", type: "timestamptz" })
  createdAt!: Date;
}
