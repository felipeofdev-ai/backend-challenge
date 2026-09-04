# Load test methodology

## Command

```bash
bun run test:load          # in-process suite (tests/load)
bun run test:load:harness  # multi-wallet script (scripts/load-harness.ts)
```

## Environment (reference run)

| Item | Value |
|---|---|
| Host | Windows 10, Bun 1.4 |
| PostgreSQL | 16 via Docker Compose, port 5433 |
| Pool | MikroORM default |
| Workload | Distinct BET ops across N wallets |
| Concurrency | Promise pool / harness `LOAD_CONCURRENCY` |

## What we measure

- **Throughput:** ops/s (wall clock / completed ProcessWager calls)
- **Latency percentiles:** p50 / p95 / p99 / max (per-op `performance.now()`)
- **Outbox lag:** count of unpublished `outbox_messages` for load wallets after the run
- **Correctness gates (hard):** unexpected rejects = 0; every wallet
  `balance == Σ credits − Σ debits`
- **Not claimed as SLA:** absolute RPS is hardware-bound and hot-wallet serialized
  (ADR-002). Numbers are forensic signals, not targets.

## Sample (2026-09-03, post-percentiles)

Harness JSON includes:

```json
{
  "msg": "load_harness_done",
  "opsPerSec": 25.5,
  "latencyMs": { "p50": 12.3, "p95": 45.0, "p99": 80.0, "max": 120.0 },
  "outboxLagMessages": 48
}
```

Re-run locally and paste the latest line into the evaluation notes — values vary by machine.

## Concurrent conflicts / outbox lag

- Lock / unique races surface as `wager_lock_conflicts_total` and idempotent replays.
- Outbox backlog on each publish tick: `outbox_lag_messages` gauge.
- Load harness reports `outboxLagMessages` after the BET storm (expected > 0 until a worker publishes).
