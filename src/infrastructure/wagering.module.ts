import { MikroOrmModule } from "@mikro-orm/nestjs";
import { EntityManager } from "@mikro-orm/postgresql";
import { Module } from "@nestjs/common";
import type { ProcessMetricsPort } from "../wagering/application/ports/metrics.port";
import {
  ProviderIdentityPort,
  StaticProviderIdentityAdapter,
} from "../wagering/application/ports/provider-identity.port";
import { ClockPort, SystemClock, UnitOfWorkPort } from "../wagering/application/ports/repositories";
import type { WagerQueuePort } from "../wagering/application/ports/wager-queue.port";
import { CreateWalletUseCase } from "../wagering/application/use-cases/create-wallet.use-case";
import { EnqueueWagerUseCase } from "../wagering/application/use-cases/enqueue-wager.use-case";
import { ProcessWagerUseCase } from "../wagering/application/use-cases/process-wager.use-case";
import {
  GetLedgerUseCase,
  GetTransactionUseCase,
  GetWalletUseCase,
} from "../wagering/application/use-cases/query.use-cases";
import { ReconcileWalletUseCase } from "../wagering/application/use-cases/reconcile-wallet.use-case";
import { HealthController } from "./http/health.controller";
import { MetricsController } from "./http/metrics.controller";
import { WageringController, WalletsController } from "./http/wagering.controller";
import { PrometheusProcessMetrics } from "./observability/prometheus-metrics.adapter";
import { InboxMessageOrmEntity } from "./orm/entities/inbox-message.orm-entity";
import { OutboxMessageOrmEntity } from "./orm/entities/outbox-message.orm-entity";
import { ReconciliationCheckOrmEntity } from "./orm/entities/reconciliation-check.orm-entity";
import { WagerTransactionOrmEntity } from "./orm/entities/wager-transaction.orm-entity";
import { WalletLedgerEntryOrmEntity } from "./orm/entities/wallet-ledger-entry.orm-entity";
import { WalletOrmEntity } from "./orm/entities/wallet.orm-entity";
import mikroConfig from "./orm/mikro-orm.config";
import { InMemoryUnitOfWork } from "./persistence/in-memory.unit-of-work";
import { MikroOrmUnitOfWork } from "./persistence/mikro-orm.unit-of-work";
import { SqsWagerQueueAdapter } from "./sqs/sqs-wager-queue.adapter";

const persistence = (process.env["PERSISTENCE"] ?? "postgres").toLowerCase();

const imports =
  persistence === "postgres"
    ? [
        MikroOrmModule.forRoot({
          ...mikroConfig,
          registerRequestContext: true,
          allowGlobalContext: true,
        }),
        MikroOrmModule.forFeature([
          WalletOrmEntity,
          WagerTransactionOrmEntity,
          WalletLedgerEntryOrmEntity,
          InboxMessageOrmEntity,
          OutboxMessageOrmEntity,
          ReconciliationCheckOrmEntity,
        ]),
      ]
    : [];

const uowProvider =
  persistence === "postgres"
    ? {
        provide: "UnitOfWorkPort",
        useFactory: (em: EntityManager): UnitOfWorkPort => new MikroOrmUnitOfWork(em),
        inject: [EntityManager],
      }
    : {
        provide: "UnitOfWorkPort",
        useFactory: (): UnitOfWorkPort => new InMemoryUnitOfWork(),
      };

@Module({
  imports,
  controllers: [WalletsController, WageringController, HealthController, MetricsController],
  providers: [
    uowProvider,
    { provide: "ClockPort", useClass: SystemClock },
    {
      provide: "ProviderIdentityPort",
      useClass: StaticProviderIdentityAdapter,
    },
    {
      provide: "ProcessMetricsPort",
      useClass: PrometheusProcessMetrics,
    },
    {
      provide: "WagerQueuePort",
      useClass: SqsWagerQueueAdapter,
    },
    {
      provide: CreateWalletUseCase,
      useFactory: (uow: UnitOfWorkPort, clock: ClockPort) => new CreateWalletUseCase(uow, clock),
      inject: ["UnitOfWorkPort", "ClockPort"],
    },
    {
      provide: ProcessWagerUseCase,
      useFactory: (
        uow: UnitOfWorkPort,
        clock: ClockPort,
        providers: ProviderIdentityPort,
        metrics: ProcessMetricsPort,
      ) => new ProcessWagerUseCase(uow, clock, providers, metrics),
      inject: ["UnitOfWorkPort", "ClockPort", "ProviderIdentityPort", "ProcessMetricsPort"],
    },
    {
      provide: EnqueueWagerUseCase,
      useFactory: (queue: WagerQueuePort) => new EnqueueWagerUseCase(queue),
      inject: ["WagerQueuePort"],
    },
    {
      provide: GetWalletUseCase,
      useFactory: (uow: UnitOfWorkPort) => new GetWalletUseCase(uow),
      inject: ["UnitOfWorkPort"],
    },
    {
      provide: GetLedgerUseCase,
      useFactory: (uow: UnitOfWorkPort) => new GetLedgerUseCase(uow),
      inject: ["UnitOfWorkPort"],
    },
    {
      provide: GetTransactionUseCase,
      useFactory: (uow: UnitOfWorkPort) => new GetTransactionUseCase(uow),
      inject: ["UnitOfWorkPort"],
    },
    {
      provide: ReconcileWalletUseCase,
      useFactory: (uow: UnitOfWorkPort, clock: ClockPort) => new ReconcileWalletUseCase(uow, clock),
      inject: ["UnitOfWorkPort", "ClockPort"],
    },
  ],
  exports: [
    CreateWalletUseCase,
    ProcessWagerUseCase,
    EnqueueWagerUseCase,
    GetWalletUseCase,
    GetLedgerUseCase,
    GetTransactionUseCase,
    ReconcileWalletUseCase,
    "UnitOfWorkPort",
  ],
})
export class WageringModule {}
