import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";

export const metricsRegistry = new Registry();

collectDefaultMetrics({ register: metricsRegistry });

export const wagerProcessedTotal = new Counter({
  name: "wager_processed_total",
  help: "Wager transactions processed by status",
  labelNames: ["kind", "status"] as const,
  registers: [metricsRegistry],
});

export const wagerDurationSeconds = new Histogram({
  name: "wager_duration_seconds",
  help: "ProcessWager wall time",
  labelNames: ["kind"] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2],
  registers: [metricsRegistry],
});

export const idempotencyDuplicatesTotal = new Counter({
  name: "wager_idempotency_duplicates_total",
  help: "Detected duplicate deliveries (inbox or idempotency replay)",
  labelNames: ["source"] as const,
  registers: [metricsRegistry],
});

export const lockConflictsTotal = new Counter({
  name: "wager_lock_conflicts_total",
  help: "Lock wait / timeout conflicts during wallet processing",
  registers: [metricsRegistry],
});

export const outboxPublishedTotal = new Counter({
  name: "outbox_published_total",
  help: "Outbox messages published to SQS",
  registers: [metricsRegistry],
});

export const outboxPublishErrorsTotal = new Counter({
  name: "outbox_publish_errors_total",
  help: "Outbox publish failures",
  registers: [metricsRegistry],
});

export const outboxLagMessages = new Gauge({
  name: "outbox_lag_messages",
  help: "Count of unpublished outbox_messages (published_at IS NULL)",
  registers: [metricsRegistry],
});

export const sqsConsumedTotal = new Counter({
  name: "sqs_consumed_total",
  help: "SQS wager messages handled",
  labelNames: ["result"] as const,
  registers: [metricsRegistry],
});

export const sqsRetriesTotal = new Counter({
  name: "sqs_retries_total",
  help: "SQS messages received with ApproximateReceiveCount > 1",
  registers: [metricsRegistry],
});

/** Approximate messages currently sitting on configured DLQ URLs (polled by worker). */
export const sqsDlqDepth = new Gauge({
  name: "sqs_dlq_depth",
  help: "ApproximateNumberOfMessages on wager DLQ (last poll)",
  registers: [metricsRegistry],
});

export const reconciliationDivergencesTotal = new Counter({
  name: "reconciliation_divergences_total",
  help: "Wallet reconciliations that reported inconsistent balances",
  registers: [metricsRegistry],
});

/** SLO: fraction of ProcessWager calls under 250ms (updated by report harness / optional sampler). */
export const wagerSloLatencyUnder250msRatio = new Gauge({
  name: "wager_slo_latency_under_250ms_ratio",
  help: "Rolling ratio of wager ops with latency < 250ms (1.0 = meet SLO)",
  registers: [metricsRegistry],
});

export const dependencyProbeFailuresTotal = new Counter({
  name: "dependency_probe_failures_total",
  help: "Health/ready dependency probe failures",
  labelNames: ["dependency"] as const,
  registers: [metricsRegistry],
});

export async function renderMetrics(): Promise<string> {
  return metricsRegistry.metrics();
}
