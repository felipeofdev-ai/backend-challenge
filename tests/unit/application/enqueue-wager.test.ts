import { describe, expect, test } from "bun:test";
import { newId } from "../../../src/shared/id";
import type { WagerQueuePort } from "../../../src/wagering/application/ports/wager-queue.port";
import { EnqueueWagerUseCase } from "../../../src/wagering/application/use-cases/enqueue-wager.use-case";
import { FailureCode } from "../../../src/wagering/domain/enums";
import { DomainError } from "../../../src/wagering/domain/errors";

describe("EnqueueWagerUseCase (opt-in WAGER_HTTP_MODE=enqueue)", () => {
  test("validates money and enqueues without mutating balance side-effects", async () => {
    const calls: Array<{ body: string; groupId: string; dedup: string }> = [];
    const queue: WagerQueuePort = {
      enqueue: async (body, groupId, dedup) => {
        calls.push({ body, groupId, dedup });
      },
    };
    const useCase = new EnqueueWagerUseCase(queue);
    const walletId = newId();
    const result = await useCase.execute({
      providerId: "p",
      externalTransactionId: "e1",
      idempotencyKey: "p:e1",
      playerId: newId(),
      walletId,
      roundId: "r",
      gameId: "g",
      kind: "BET",
      money: { amount: "10.00", currency: "BRL" },
    });
    expect(result.status).toBe("PENDING");
    expect(result.balance).toBeNull();
    expect(result.httpHint).toBe("accepted");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.groupId).toBe(walletId);
    const parsed = JSON.parse(calls[0]!.body) as { type: string; data: { kind: string } };
    expect(parsed.type).toBe("WagerTransactionRequested");
    expect(parsed.data.kind).toBe("BET");
  });

  test("rejects invalid money before enqueue", async () => {
    const useCase = new EnqueueWagerUseCase({
      enqueue: async () => {
        throw new Error("should not enqueue");
      },
    });
    await expect(
      useCase.execute({
        providerId: "p",
        externalTransactionId: "e2",
        idempotencyKey: "p:e2",
        playerId: newId(),
        walletId: newId(),
        roundId: "r",
        gameId: "g",
        kind: "BET",
        money: { amount: "10.001", currency: "BRL" },
      }),
    ).rejects.toBeInstanceOf(DomainError);
  });

  test("rejects OPENING kind", async () => {
    const useCase = new EnqueueWagerUseCase({
      enqueue: async () => undefined,
    });
    try {
      await useCase.execute({
        providerId: "p",
        externalTransactionId: "e3",
        idempotencyKey: "p:e3",
        playerId: newId(),
        walletId: newId(),
        roundId: "r",
        gameId: "g",
        kind: "OPENING",
        money: { amount: "1.00", currency: "BRL" },
      });
      throw new Error("expected failure");
    } catch (err) {
      expect(err).toBeInstanceOf(DomainError);
      expect((err as DomainError).code).toBe(FailureCode.VALIDATION_ERROR);
    }
  });
});
