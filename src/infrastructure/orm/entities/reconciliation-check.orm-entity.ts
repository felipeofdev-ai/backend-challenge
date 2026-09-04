import { Entity, PrimaryKey, Property } from "@mikro-orm/core";

@Entity({ tableName: "reconciliation_checks" })
export class ReconciliationCheckOrmEntity {
  @PrimaryKey({ type: "uuid" })
  id!: string;

  @Property({ fieldName: "wallet_id", type: "uuid" })
  walletId!: string;

  @Property({ fieldName: "stored_balance", type: "decimal", precision: 38, scale: 2 })
  storedBalance!: string;

  @Property({ fieldName: "calculated_balance", type: "decimal", precision: 38, scale: 2 })
  calculatedBalance!: string;

  @Property({ type: "decimal", precision: 38, scale: 2 })
  difference!: string;

  @Property({ type: "boolean" })
  consistent!: boolean;

  @Property({ fieldName: "checked_entries", type: "integer" })
  checkedEntries!: number;

  @Property({ fieldName: "created_at", type: "timestamptz" })
  createdAt!: Date;
}
