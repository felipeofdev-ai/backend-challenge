import { createHash } from "node:crypto";

/**
 * Canonical payload hash for idempotency.
 *
 * Algorithm (documented in README / ARCHITECTURE):
 * 1. Take business subset: providerId, externalTransactionId, walletId, playerId,
 *    roundId, gameId, kind, money{amount,currency}
 * 2. Normalize money.amount to exactly 2 decimal places
 * 3. Recursively sort object keys lexicographically; omit undefined; keep null
 * 4. JSON.stringify without spaces
 * 5. SHA-256 → hex (64 chars)
 *
 * Headers, messageId, occurredAt, and transport metadata are excluded.
 */
export function canonicalPayloadHash(input: {
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: { amount: string; currency: string };
  referenceExternalTransactionId?: string;
}): string {
  const subset: Record<string, unknown> = {
    externalTransactionId: input.externalTransactionId,
    gameId: input.gameId,
    kind: input.kind,
    money: {
      amount: normalizeAmount(input.money.amount),
      currency: input.money.currency,
    },
    playerId: input.playerId,
    providerId: input.providerId,
    roundId: input.roundId,
    walletId: input.walletId,
  };

  if (input.referenceExternalTransactionId !== undefined) {
    subset["referenceExternalTransactionId"] = input.referenceExternalTransactionId;
  }

  const canonical = stableStringify(subset);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function normalizeAmount(amount: string): string {
  const [whole, frac = ""] = amount.split(".");
  return `${whole}.${frac.padEnd(2, "0").slice(0, 2)}`;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  const obj = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    const v = obj[key];
    if (v === undefined) continue;
    sorted[key] = sortKeys(v);
  }
  return sorted;
}
