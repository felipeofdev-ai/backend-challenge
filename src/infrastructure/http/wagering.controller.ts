import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Res,
} from "@nestjs/common";
import type { Response } from "express";
import { loadConfig } from "../../shared/config";
import { CreateWalletUseCase } from "../../wagering/application/use-cases/create-wallet.use-case";
import { EnqueueWagerUseCase } from "../../wagering/application/use-cases/enqueue-wager.use-case";
import { ProcessWagerUseCase } from "../../wagering/application/use-cases/process-wager.use-case";
import {
  GetLedgerUseCase,
  GetTransactionUseCase,
  GetWalletUseCase,
} from "../../wagering/application/use-cases/query.use-cases";
import { ReconcileWalletUseCase } from "../../wagering/application/use-cases/reconcile-wallet.use-case";
import { DomainError, FailureCode } from "../../wagering/domain";
import { logger } from "../observability/logger";
import {
  idempotencyDuplicatesTotal,
  reconciliationDivergencesTotal,
  wagerDurationSeconds,
  wagerProcessedTotal,
} from "../observability/metrics";
import { withWagerSpan } from "../observability/tracing";

@Controller()
export class WalletsController {
  constructor(
    private readonly createWallet: CreateWalletUseCase,
    private readonly getWallet: GetWalletUseCase,
    private readonly getLedger: GetLedgerUseCase,
    private readonly reconcileWallet: ReconcileWalletUseCase,
  ) {}

  @Post("wallets")
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body()
    body: {
      playerId?: string;
      initialBalance?: { amount?: string; currency?: string };
    },
  ) {
    if (!body.playerId || !body.initialBalance?.amount || !body.initialBalance.currency) {
      throw new DomainError(FailureCode.VALIDATION_ERROR, "playerId and initialBalance required");
    }
    return this.createWallet.execute({
      playerId: body.playerId,
      initialBalance: {
        amount: body.initialBalance.amount,
        currency: body.initialBalance.currency,
      },
    });
  }

  @Get("wallets/:walletId")
  async get(@Param("walletId") walletId: string) {
    return this.getWallet.execute(walletId);
  }

  @Get("wallets/:walletId/ledger")
  async ledger(
    @Param("walletId") walletId: string,
    @Query("cursor") cursor?: string,
    @Query("limit") limit?: string,
  ) {
    return this.getLedger.execute(walletId, {
      ...(cursor !== undefined ? { cursor } : {}),
      ...(limit !== undefined ? { limit: Number(limit) } : {}),
    });
  }

  @Post("wallets/:walletId/reconciliation")
  @HttpCode(HttpStatus.OK)
  async reconcile(@Param("walletId") walletId: string) {
    const result = await this.reconcileWallet.execute(walletId);
    if (!result.consistent) {
      reconciliationDivergencesTotal.inc();
      logger.error({
        msg: "reconciliation_divergence",
        walletId: result.walletId,
        stored: result.storedBalance.amount,
        calculated: result.calculatedBalance.amount,
        difference: result.difference.amount,
      });
    }
    return result;
  }
}

@Controller()
export class WageringController {
  constructor(
    private readonly processWager: ProcessWagerUseCase,
    private readonly enqueueWager: EnqueueWagerUseCase,
    private readonly getTransaction: GetTransactionUseCase,
  ) {}

  @Post("wagering/transactions")
  async submit(
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body()
    body: {
      providerId?: string;
      externalTransactionId?: string;
      playerId?: string;
      walletId?: string;
      roundId?: string;
      gameId?: string;
      kind?: string;
      money?: { amount?: string; currency?: string };
      referenceExternalTransactionId?: string;
    },
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!idempotencyKey) {
      throw new DomainError(
        FailureCode.MISSING_IDEMPOTENCY_KEY,
        "Idempotency-Key header is required",
      );
    }
    if (
      !body.providerId ||
      !body.externalTransactionId ||
      !body.playerId ||
      !body.walletId ||
      !body.roundId ||
      !body.gameId ||
      !body.kind ||
      !body.money?.amount ||
      !body.money.currency
    ) {
      throw new DomainError(FailureCode.VALIDATION_ERROR, "Missing required fields");
    }

    const input = {
      providerId: body.providerId,
      externalTransactionId: body.externalTransactionId,
      idempotencyKey,
      playerId: body.playerId,
      walletId: body.walletId,
      roundId: body.roundId,
      gameId: body.gameId,
      kind: body.kind,
      money: { amount: body.money.amount, currency: body.money.currency },
      ...(body.referenceExternalTransactionId !== undefined
        ? { referenceExternalTransactionId: body.referenceExternalTransactionId }
        : {}),
    };

    const httpMode = loadConfig().wagerHttpMode;
    if (httpMode === "enqueue") {
      const started = process.hrtime.bigint();
      try {
        const queued = await withWagerSpan(
          "http.EnqueueWager",
          {
            "wager.kind": body.kind,
            "wallet.id": body.walletId,
            "provider.id": body.providerId,
            "http.mode": "enqueue",
          },
          async (correlation) =>
            this.enqueueWager.execute({
              ...input,
              correlationId: correlation.correlationId,
            }),
        );
        const elapsed = Number(process.hrtime.bigint() - started) / 1_000_000_000;
        wagerDurationSeconds.observe({ kind: body.kind }, elapsed);
        wagerProcessedTotal.inc({ kind: body.kind, status: "PENDING" });
        res.status(HttpStatus.ACCEPTED);
        logger.info({
          msg: "wager_http_enqueued",
          providerId: body.providerId,
          walletId: body.walletId,
          messageId: queued.messageId,
          kind: body.kind,
          durationMs: Number((elapsed * 1000).toFixed(2)),
        });
        return {
          status: queued.status,
          messageId: queued.messageId,
          balance: null,
          idempotentReplay: false,
        };
      } catch (err) {
        const elapsed = Number(process.hrtime.bigint() - started) / 1_000_000_000;
        wagerDurationSeconds.observe({ kind: body.kind }, elapsed);
        throw err;
      }
    }

    const started = process.hrtime.bigint();
    try {
      const result = await withWagerSpan(
        "http.ProcessWager",
        {
          "wager.kind": body.kind,
          "wallet.id": body.walletId,
          "provider.id": body.providerId,
          "http.mode": "sync",
        },
        async (correlation) =>
          this.processWager.execute({
            ...input,
            correlationId: correlation.correlationId,
          }),
      );

      const elapsed = Number(process.hrtime.bigint() - started) / 1_000_000_000;
      wagerDurationSeconds.observe({ kind: body.kind }, elapsed);
      wagerProcessedTotal.inc({ kind: body.kind, status: result.status });
      if (result.idempotentReplay) {
        idempotencyDuplicatesTotal.inc({ source: "http_idempotency" });
      }
      logger.info({
        msg: "wager_http_processed",
        providerId: body.providerId,
        walletId: body.walletId,
        transactionId: result.transactionId,
        status: result.status,
        kind: body.kind,
        idempotentReplay: result.idempotentReplay,
        durationMs: Number((elapsed * 1000).toFixed(2)),
      });

      if (result.httpHint === "accepted") {
        res.status(HttpStatus.ACCEPTED);
      } else if (result.httpHint === "rejected") {
        res.status(HttpStatus.UNPROCESSABLE_ENTITY);
        return {
          error: {
            code: result.failureCode ?? "REJECTED",
            message: `Transaction ${result.status}`,
            transactionId: result.transactionId,
            retryable: false,
            idempotentReplay: result.idempotentReplay,
            details: {
              status: result.status,
              balance: result.balance,
            },
          },
        };
      } else {
        res.status(HttpStatus.OK);
      }

      return {
        transactionId: result.transactionId,
        status: result.status,
        balance: result.balance,
        idempotentReplay: result.idempotentReplay,
        ...(result.failureCode !== undefined ? { failureCode: result.failureCode } : {}),
      };
    } catch (err) {
      const elapsed = Number(process.hrtime.bigint() - started) / 1_000_000_000;
      wagerDurationSeconds.observe({ kind: body.kind }, elapsed);
      throw err;
    }
  }

  @Get("wagering/transactions/:transactionId")
  async getById(@Param("transactionId") transactionId: string) {
    return this.getTransaction.byId(transactionId);
  }

  @Get("providers/:providerId/wagering/transactions/:externalTransactionId")
  async getByExternal(
    @Param("providerId") providerId: string,
    @Param("externalTransactionId") externalTransactionId: string,
  ) {
    return this.getTransaction.byExternal(providerId, externalTransactionId);
  }
}
