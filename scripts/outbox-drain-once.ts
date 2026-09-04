/**
 * One-shot outbox drain for restart-recovery tests (fresh ORM process).
 * Args: aggregateId
 */
import { MikroORM } from "@mikro-orm/postgresql";
import config from "../mikro-orm.config";
import { MikroOrmUnitOfWork } from "../src/infrastructure/persistence/mikro-orm.unit-of-work";
import { OutboxPublisher } from "../src/infrastructure/sqs/outbox-publisher";
import { SystemClock } from "../src/wagering/application/ports/repositories";

const aggregateId = process.argv[2]!;
process.env["DATABASE_PORT"] = process.env["DATABASE_PORT"] ?? "5433";

async function main(): Promise<void> {
  const orm = await MikroORM.init({ ...config, debug: false });
  await orm.em.getConnection().execute(
    `UPDATE outbox_messages SET next_attempt_at = TIMESTAMPTZ '1970-01-01 00:00:00+00'
     WHERE aggregate_id = ? AND published_at IS NULL`,
    [aggregateId],
  );

  const uow = new MikroOrmUnitOfWork(orm.em.fork());
  const publisher = new OutboxPublisher(
    uow,
    { publishEvent: async () => undefined } as never,
    new SystemClock(),
    60_000,
  );

  let published = 0;
  for (let i = 0; i < 10; i++) {
    const n = await publisher.publishBatch(100);
    published += n;
    if (n === 0) break;
    await orm.em.getConnection().execute(
      `UPDATE outbox_messages SET next_attempt_at = TIMESTAMPTZ '1970-01-01 00:00:00+00'
       WHERE aggregate_id = ? AND published_at IS NULL`,
      [aggregateId],
    );
  }

  const rows = (await orm.em.getConnection().execute(
    `SELECT COUNT(*)::int AS c FROM outbox_messages
     WHERE aggregate_id = ? AND published_at IS NULL`,
    [aggregateId],
  )) as Array<{ c: number }>;

  console.log(JSON.stringify({ msg: "outbox_drain_done", published, left: rows[0]?.c ?? -1 }));
  await orm.close(true);
  if ((rows[0]?.c ?? -1) !== 0) process.exit(2);
}

main().catch((err) => {
  console.error(String(err));
  process.exit(1);
});
