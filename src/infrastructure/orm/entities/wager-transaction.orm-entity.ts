import { Entity, Index, PrimaryKey, Property, Unique } from "@mikro-orm/core";

@Entity({ tableName: "wager_transactions" })
@Unique({
  properties: ["providerId", "idempotencyKey"],
  name: "uq_wager_tx_idempotency",
})
@Unique({
  properties: ["providerId", "externalTransactionId"],
  name: "uq_wager_tx_external",
})
@Index({
  properties: ["providerId", "referenceExternalTransactionId"],
  name: "ix_wager_tx_reference",
})
export class WagerTransactionOrmEntity {
  @PrimaryKey({ type: "uuid" })
  id!: string;

  @Property({ fieldName: "provider_id", type: "string", length: 64 })
  providerId!: string;

  @Property({ fieldName: "external_transaction_id", type: "string", length: 128 })
  externalTransactionId!: string;

  @Property({ fieldName: "idempotency_key", type: "string", length: 255 })
  idempotencyKey!: string;

  @Property({ fieldName: "payload_hash", type: "string", length: 64 })
  payloadHash!: string;

  @Property({ fieldName: "wallet_id", type: "uuid" })
  walletId!: string;

  @Property({ fieldName: "player_id", type: "uuid" })
  playerId!: string;

  @Property({ fieldName: "round_id", type: "string", length: 128 })
  roundId!: string;

  @Property({ fieldName: "game_id", type: "string", length: 128 })
  gameId!: string;

  @Property({ type: "string", length: 16 })
  kind!: string;

  @Property({ type: "string", length: 32 })
  status!: string;

  @Property({ type: "decimal", precision: 38, scale: 2 })
  amount!: string;

  @Property({ type: "string", length: 3 })
  currency!: string;

  @Property({
    fieldName: "reference_external_transaction_id",
    type: "string",
    length: 128,
    nullable: true,
  })
  referenceExternalTransactionId?: string | null;

  @Property({ fieldName: "reference_transaction_id", type: "uuid", nullable: true })
  referenceTransactionId?: string | null;

  @Property({ fieldName: "failure_code", type: "string", length: 64, nullable: true })
  failureCode?: string | null;

  @Property({
    fieldName: "result_balance",
    type: "decimal",
    precision: 38,
    scale: 2,
    nullable: true,
  })
  resultBalance?: string | null;

  @Property({ fieldName: "reference_attempts", type: "integer" })
  referenceAttempts = 0;

  @Property({ fieldName: "next_reprocess_at", type: "timestamptz", nullable: true })
  nextReprocessAt?: Date | null;

  @Property({ fieldName: "reprocess_deadline", type: "timestamptz", nullable: true })
  reprocessDeadline?: Date | null;

  @Property({ fieldName: "created_at", type: "timestamptz" })
  createdAt!: Date;

  @Property({ fieldName: "processed_at", type: "timestamptz", nullable: true })
  processedAt?: Date | null;
}
