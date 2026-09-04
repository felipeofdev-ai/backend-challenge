import { Entity, PrimaryKey, Property } from "@mikro-orm/core";

@Entity({ tableName: "inbox_messages" })
export class InboxMessageOrmEntity {
  @PrimaryKey({ fieldName: "consumer_name", type: "string", length: 64 })
  consumerName!: string;

  @PrimaryKey({ fieldName: "message_id", type: "string", length: 255 })
  messageId!: string;

  @Property({ fieldName: "payload_hash", type: "string", length: 64 })
  payloadHash!: string;

  @Property({ fieldName: "received_at", type: "timestamptz" })
  receivedAt!: Date;

  @Property({ fieldName: "processed_at", type: "timestamptz", nullable: true })
  processedAt?: Date | null;
}
