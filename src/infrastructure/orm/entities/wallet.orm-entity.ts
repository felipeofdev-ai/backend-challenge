import { Entity, PrimaryKey, Property, Unique } from "@mikro-orm/core";

@Entity({ tableName: "wallets" })
@Unique({ properties: ["playerId", "currency"], name: "uq_wallets_player_currency" })
export class WalletOrmEntity {
  @PrimaryKey({ type: "uuid" })
  id!: string;

  @Property({ fieldName: "player_id", type: "uuid" })
  playerId!: string;

  @Property({ type: "string", length: 3 })
  currency!: string;

  /** NUMERIC(38,2) — always string at the driver boundary. */
  @Property({ type: "decimal", precision: 38, scale: 2 })
  balance!: string;

  @Property({ type: "bigint" })
  version!: string;

  @Property({ fieldName: "created_at", type: "timestamptz" })
  createdAt!: Date;

  @Property({ fieldName: "updated_at", type: "timestamptz" })
  updatedAt!: Date;
}
