import { Migrator } from "@mikro-orm/migrations";
import { defineConfig } from "@mikro-orm/postgresql";
import { InboxMessageOrmEntity } from "./entities/inbox-message.orm-entity";
import { OutboxMessageOrmEntity } from "./entities/outbox-message.orm-entity";
import { ReconciliationCheckOrmEntity } from "./entities/reconciliation-check.orm-entity";
import { WagerTransactionOrmEntity } from "./entities/wager-transaction.orm-entity";
import { WalletLedgerEntryOrmEntity } from "./entities/wallet-ledger-entry.orm-entity";
import { WalletOrmEntity } from "./entities/wallet.orm-entity";

const config = defineConfig({
  host: process.env["DATABASE_HOST"] ?? "localhost",
  port: Number(process.env["DATABASE_PORT"] ?? 5433),
  user: process.env["DATABASE_USER"] ?? "wagering",
  password: process.env["DATABASE_PASSWORD"] ?? "wagering",
  dbName: process.env["DATABASE_NAME"] ?? "wagering",
  entities: [
    WalletOrmEntity,
    WagerTransactionOrmEntity,
    WalletLedgerEntryOrmEntity,
    InboxMessageOrmEntity,
    OutboxMessageOrmEntity,
    ReconciliationCheckOrmEntity,
  ],
  migrations: {
    path: "migrations",
    pathTs: "migrations",
    glob: "!(*.d).{js,ts}",
    transactional: true,
    allOrNothing: true,
  },
  extensions: [Migrator],
  debug: process.env["NODE_ENV"] === "development",
  pool: {
    min: Number(process.env["DATABASE_POOL_MIN"] ?? 2),
    max: Number(process.env["DATABASE_POOL_MAX"] ?? 20),
    // Fail closed under saturation instead of hanging forever (ADR-023)
    acquireTimeoutMillis: Number(process.env["DATABASE_POOL_ACQUIRE_MS"] ?? 5_000),
  },
});

export default config;
