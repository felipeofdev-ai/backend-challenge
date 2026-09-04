import "reflect-metadata";
import { MikroORM } from "@mikro-orm/postgresql";
import config from "../mikro-orm.config";
import { logger } from "./infrastructure/observability/logger";
import { startOtelIfConfigured } from "./infrastructure/observability/otel-bootstrap";
import { MikroOrmUnitOfWork } from "./infrastructure/persistence/mikro-orm.unit-of-work";
import { DlqDepthPoller } from "./infrastructure/sqs/dlq-depth-poller";
import { OutboxPublisher } from "./infrastructure/sqs/outbox-publisher";
import {
  SqsMessagingAdapter,
  createSqsClient,
  loadSqsConfigFromEnv,
} from "./infrastructure/sqs/sqs.adapter";
import { WagerSqsConsumer } from "./infrastructure/sqs/wager-consumer";
import { applyDatabaseEnv, loadConfig } from "./shared/config";
import { SystemClock } from "./wagering/application/ports/repositories";
import { ProcessWagerUseCase } from "./wagering/application/use-cases/process-wager.use-case";
import { ReprocessPendingReferencesUseCase } from "./wagering/application/use-cases/reprocess-pending.use-case";

async function main(): Promise<void> {
  await startOtelIfConfigured();
  const appConfig = loadConfig();
  applyDatabaseEnv(appConfig);

  const orm = await MikroORM.init(config);
  const uow = new MikroOrmUnitOfWork(orm.em);
  const clock = new SystemClock();
  const processWager = new ProcessWagerUseCase(uow, clock);
  const reprocess = new ReprocessPendingReferencesUseCase(uow, clock);

  const sqsCfg = loadSqsConfigFromEnv();
  const sqsClient = createSqsClient(sqsCfg);
  const sqs = new SqsMessagingAdapter(sqsClient, sqsCfg.wagerQueueUrl, sqsCfg.eventsQueueUrl);

  const consumer = new WagerSqsConsumer(sqs, processWager);
  const publisher = new OutboxPublisher(uow, sqs, clock, appConfig.workers.outboxPollIntervalMs);
  const dlqUrl =
    process.env["SQS_WAGER_DLQ_URL"] ??
    "http://localhost:4566/000000000000/wager-transactions-dlq.fifo";
  const dlqPoller = new DlqDepthPoller(sqsClient, dlqUrl, 15_000);
  const refInterval = appConfig.workers.referencePollIntervalMs;

  consumer.start();
  publisher.start();
  dlqPoller.start();

  const refTimer = setInterval(() => {
    void reprocess
      .execute(50)
      .then((r) => {
        if (r.processed + r.rejected + r.deferred > 0) {
          logger.info({ msg: "pending_reference_tick", ...r });
        }
      })
      .catch((err: unknown) => {
        logger.error({ msg: "pending_reference_tick_failed", error: String(err) });
      });
  }, refInterval);

  logger.info({
    msg: "worker_started",
    components: ["sqs-consumer", "outbox-publisher", "pending-reference", "dlq-depth-poller"],
  });

  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    logger.info({ msg: "worker_shutdown_begin", signal });
    clearInterval(refTimer);
    dlqPoller.stop();
    await publisher.stop();
    await consumer.stop(15_000);
    await orm.close(true);
    logger.info({ msg: "worker_shutdown_complete" });
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err: unknown) => {
  logger.error({ msg: "worker_boot_failed", error: String(err) });
  process.exit(1);
});
