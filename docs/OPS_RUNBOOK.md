# Operations runbook — wagering-processor

Disaster / continuity assumptions for local and staging demos (not a cloud multi-AZ product yet).

## RPO / RTO targets (design intent)

| Scenario | RPO | RTO | Mechanism |
|---|---|---|---|
| Single API/worker crash | **0** (committed SQL) | **&lt; 30s** | restart process; outbox + SQS redelivery |
| Postgres primary loss (single node) | **up to last WAL flush** | **minutes** (restore volume / promote) | Docker volume + reversible migrations |
| LocalStack SQS loss | **0 for committed outbox** | **&lt; 1m** recreate queues | outbox republish; inbox idempotency |
| Full compose wipe | **data loss** unless volume backed up | **redeploy** | `docker compose up` + `migration:up` |

**Truth:** PostgreSQL is the system of record. SQS is an optimization / transport. Never treat FIFO alone as RPO=0.

## Multi-instance (same AZ / shared DB)

```bash
docker compose --profile multi-instance up -d --build
```

- Unit of concurrency remains `walletId` (`SELECT … FOR UPDATE`).
- Outbox publishers use `SKIP LOCKED` + claim lease.
- Ack SQS only after SQL commit (`executeFromQueue`).

## Auth IdP (0 scoring points)

```bash
docker compose --profile auth up -d
# AUTH_MODE=oidc KEYCLOAK_ISSUER=http://localhost:8080/realms/jungle-gaming
```

## Optional network chaos (Toxiproxy)

```bash
docker compose --profile chaos up -d
```

## Observability UI

```bash
docker compose --profile obs up -d
# Prometheus :9090 · Grafana :3005 (admin/admin) · dashboard "Wagering Processor"
```

API must expose `/metrics` on the host (e.g. `bun run start`) for Prometheus `host.docker.internal:3000`.

## Multi-instance gateway

```bash
docker compose --profile multi-instance up -d --build
# single entry: http://localhost:8088 → api-1/2/3 (least_conn)
```

## OpenTelemetry OTLP

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
OTEL_SERVICE_NAME=wagering-processor
bun run start
```

Without the endpoint, spans stay on the no-op TracerProvider (API-only).

## HTTP modes

| `WAGER_HTTP_MODE` | Behavior | Challenge eval |
|---|---|---|
| `sync` (default) | ProcessWager in-request; `200`/`422`/`202` PENDING_REFERENCE | **use this** |
| `enqueue` | Validate + SQS enqueue; `202 PENDING` (no balance yet) | opt-in scale path only |

Financial atomicity still lives in the worker TX (wallet+ledger+inbox+outbox).

## Recovery checklist

1. `GET /health/ready` — PG + SQS
2. `GET /metrics` — `outbox_lag_messages`, `dependency_probe_failures_total`
3. `POST /wallets/:id/reconciliation` — never silent-fix
4. Restart worker → drains outbox / pending-reference
5. Redelivered SQS messages → inbox + idempotency → no double debit/credit

## Pool sizing & lock timeouts (ADR-023)

| Knob | Default | Role |
|---|---|---|
| `DATABASE_POOL_MAX` | 20 | Cap concurrent SQL connections per process |
| `DATABASE_POOL_ACQUIRE_MS` | 5000 | Fail closed under saturation → 503 |
| `LOCK_TIMEOUT_MS` | 2000 | Per-TX wait on `FOR UPDATE` — free the slot |
| `LOCK_RETRY_MAX` | 3 | App-level retries after lock timeout |
| `IN_FLIGHT_VISIBILITY_SECONDS` | 5 | SQS defer when peer holds uncommitted inbox claim |

Rule of thumb: `POOL_MAX ≥ (api + worker processes) × concurrent_msgs + 2`.

## in_flight → DLQ path (interview)

1. Worker A has uncommitted inbox INSERT; Worker B hits ON CONFLICT → `in_flight`.
2. B defers visibility (`IN_FLIGHT_VISIBILITY_SECONDS`), does **not** ack.
3. A commits → next B receive → `duplicate` → ack. A aborts → claim gone → B `proceed`.
4. If receives keep failing across `maxReceiveCount` → DLQ (`sqs_dlq_depth`); fix root cause; redrive.
