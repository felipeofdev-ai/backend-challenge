import { MikroORM } from "@mikro-orm/postgresql";
import config from "../mikro-orm.config";

async function main(): Promise<void> {
  const orm = await MikroORM.init(config);
  const migrator = orm.getMigrator();
  const pending = await migrator.getPendingMigrations();
  console.log(JSON.stringify({ msg: "migrations_pending", count: pending.length }));
  const executed = await migrator.up();
  console.log(
    JSON.stringify({
      msg: "migrations_applied",
      count: executed.length,
      names: executed.map((m) => m.name),
    }),
  );
  await orm.close(true);
}

main().catch((err: unknown) => {
  console.error(JSON.stringify({ msg: "migration_failed", error: String(err) }));
  process.exit(1);
});
