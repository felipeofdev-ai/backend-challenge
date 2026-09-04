import { describe, expect, test } from "bun:test";
import { canonicalPayloadHash } from "../../../src/shared/canonical-hash";

describe("canonicalPayloadHash", () => {
  const payload = {
    providerId: "provider-a",
    externalTransactionId: "transaction-123",
    walletId: "0192f291-27dd-7d3f-8071-5f8685deef37",
    playerId: "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    roundId: "round-987",
    gameId: "fortune-chimp",
    kind: "BET",
    money: { amount: "25.00", currency: "BRL" },
  };

  test("is stable regardless of key insertion order", () => {
    const a = canonicalPayloadHash(payload);
    const b = canonicalPayloadHash({
      money: payload.money,
      kind: payload.kind,
      gameId: payload.gameId,
      roundId: payload.roundId,
      playerId: payload.playerId,
      walletId: payload.walletId,
      externalTransactionId: payload.externalTransactionId,
      providerId: payload.providerId,
    });
    expect(a).toBe(b);
    expect(a).toHaveLength(64);
  });

  test("normalizes amount scale in hash", () => {
    const with25 = canonicalPayloadHash({
      ...payload,
      money: { amount: "25", currency: "BRL" },
    });
    const with2500 = canonicalPayloadHash(payload);
    expect(with25).toBe(with2500);
  });

  test("diverges when business field changes", () => {
    const a = canonicalPayloadHash(payload);
    const b = canonicalPayloadHash({
      ...payload,
      money: { amount: "26.00", currency: "BRL" },
    });
    expect(a).not.toBe(b);
  });
});
