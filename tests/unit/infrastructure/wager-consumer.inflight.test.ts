import { describe, expect, mock, test } from "bun:test";
import { WagerSqsConsumer } from "../../../src/infrastructure/sqs/wager-consumer";

describe("WagerSqsConsumer · in_flight visibility", () => {
  test("in_flight defers visibility (backoff) — does not ack or release to 0", async () => {
    const deferred: number[] = [];
    const acked: string[] = [];
    const released: string[] = [];

    const sqs = {
      receiveWagerMessages: mock(async () => []),
      ackWager: mock(async (h: string) => {
        acked.push(h);
      }),
      releaseWagerVisibility: mock(async (h: string) => {
        released.push(h);
      }),
      deferWagerVisibility: mock(async (_h: string, seconds: number) => {
        deferred.push(seconds);
      }),
    };

    const processWager = {
      executeFromQueue: mock(async () => ({ kind: "in_flight" as const })),
    };

    process.env["IN_FLIGHT_VISIBILITY_SECONDS"] = "7";
    const consumer = new WagerSqsConsumer(sqs as never, processWager as never);

    const envelope = {
      messageId: "msg-1",
      type: "WagerTransactionRequested",
      occurredAt: new Date().toISOString(),
      data: {
        providerId: "p",
        externalTransactionId: "e1",
        playerId: "pl",
        walletId: "w",
        roundId: "r",
        gameId: "g",
        kind: "BET",
        money: { amount: "1.00", currency: "BRL" },
      },
    };

    await (
      consumer as unknown as {
        handle: (msg: {
          body: string;
          receiptHandle: string;
          messageId: string;
          receiveCount: number;
        }) => Promise<void>;
      }
    ).handle({
      body: JSON.stringify(envelope),
      receiptHandle: "rh-1",
      messageId: "sqs-1",
      receiveCount: 2,
    });

    expect(deferred).toEqual([7]);
    expect(acked).toEqual([]);
    expect(released).toEqual([]);
  });
});
