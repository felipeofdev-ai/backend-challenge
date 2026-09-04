/**
 * Smoke: enqueue one WagerTransactionRequested and exit.
 * Usage: bun run scripts/enqueue-wager.ts <walletId> <playerId>
 */
import {
  createSqsClient,
  loadSqsConfigFromEnv,
  SqsMessagingAdapter,
} from "../src/infrastructure/sqs/sqs.adapter";
import { newId } from "../src/shared/id";

const walletId = process.argv[2];
const playerId = process.argv[3];
if (!walletId || !playerId) {
  console.error("usage: bun run scripts/enqueue-wager.ts <walletId> <playerId>");
  process.exit(1);
}

const cfg = loadSqsConfigFromEnv();
const sqs = new SqsMessagingAdapter(createSqsClient(cfg), cfg.wagerQueueUrl, cfg.eventsQueueUrl);

const messageId = `msg-${newId()}`;
const externalTransactionId = `sqs-bet-${Date.now()}`;
const body = {
  messageId,
  type: "WagerTransactionRequested",
  occurredAt: new Date().toISOString(),
  data: {
    providerId: "provider-a",
    externalTransactionId,
    idempotencyKey: `provider-a:${externalTransactionId}`,
    playerId,
    walletId,
    roundId: "sqs-round",
    gameId: "fortune-chimp",
    kind: "BET",
    money: { amount: "15.00", currency: "BRL" },
  },
};

await sqs.enqueueWager(JSON.stringify(body), walletId, messageId);
console.log(JSON.stringify({ msg: "enqueued", messageId, externalTransactionId, walletId }));
