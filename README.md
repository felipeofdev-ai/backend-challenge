# Wagering Processor — Jungle Gaming Challenge

Distributed wagering processor: financial correctness under at-least-once delivery, multi-instance concurrency, and crash recovery.

**Stack:** Bun 1.x · TypeScript strict · NestJS 11 · MikroORM 6 · PostgreSQL 16 · LocalStack SQS FIFO

## Guarantees

| Invariant | Enforced by |
|---|---|
| No duplicate debit/credit | `UNIQUE (provider_id, idempotency_key)` + ledger `UNIQUE (transaction_id)` + inbox |
| Never negative balance | `SELECT … FOR UPDATE` + `CHECK (balance >= 0)` |
| No lost confirmed events | Transactional outbox (same SQL TX) |
| Ledger immutable | DB trigger blocks UPDATE/DELETE |
| Correct under N instances | Pessimistic lock per `walletId` + concurrency suite |

## Quick start

```bash
bun install
cp .env.example .env
docker compose up -d
# Postgres do desafio escuta em :5433 (evita conflito com PostgreSQL local :5432)
bun run migration:up
bun run typecheck
bun run dev            # API :3000
bun run worker         # SQS + outbox + pending-reference (phases 5–7)
```

### Multi-instance (Docker)

```bash
docker compose --profile app up -d --build           # 1 API + worker
docker compose --profile multi-instance up -d --build # APIs :3000/:3001/:3002 + worker
```

Postgres is tuned for lock visibility (`log_lock_waits`, `lock_timeout`). See ADR-016.

Health (no auth):

```bash
curl http://localhost:3000/health/live
curl http://localhost:3000/health/ready   # probes PostgreSQL + SQS
curl http://localhost:3000/metrics        # Prometheus text
# OpenAPI / Swagger UI
# http://localhost:3000/docs
```

Reconciliation:

```bash
curl -X POST http://localhost:3000/wallets/<walletId>/reconciliation
```

## Tests

```bash
bun test                 # unit
bun run test:forensic    # invariant + schema forensics
bun run test:concurrency # real Postgres races + ≥3 OS processes
bun test tests/integration # SQS E2E (fila FIFO isolada; PG + LocalStack)
bun run test:load        # sustained load + harness
bun run lint             # Biome
bun run test:all         # sequential suites (avoids shared-PG contention)
bun run test:chaos       # resilience / atomicity chaos
bun run report:system    # detailed latency + atomicity JSON/MD report
```

Final invariant in every balance-touching test: `wallet.balance == Σ(ledger credits) − Σ(ledger debits)`.

## Observability

- **Logs:** pino JSON (`LOG_LEVEL`, `APP_NAME`) + `durationMs` / OTel spans on ProcessWager
- **Metrics:** `GET /metrics` — wager/outbox/SQS counters, `wager_slo_latency_under_250ms_ratio`, `dependency_probe_failures_total`
- **Ready:** `503` when PostgreSQL or SQS is unreachable (`PERSISTENCE=memory` is a unit-test double only; default is Postgres)
- **Report:** `bun run report:system` → `docs/SYSTEM_REPORT.{json,md}`

## payloadHash algorithm

1. Business subset: `providerId`, `externalTransactionId`, `walletId`, `playerId`, `roundId`, `gameId`, `kind`, `money`, optional `referenceExternalTransactionId`
2. Normalize `money.amount` to exactly 2 decimal places
3. Sort object keys lexicographically (recursive); omit `undefined`
4. `JSON.stringify` (no spaces) → SHA-256 hex

Header `Idempotency-Key`, `messageId`, and transport metadata are **excluded**.

Same key + same hash → idempotent replay. Same key + different hash → `409 IDEMPOTENCY_CONFLICT`.

## Auth

`AUTH_MODE=static` (default): extension point via `AuthGuard` + `ProviderIdentityPort`.  
`AUTH_MODE=oidc`: JWT verified against Keycloak JWKS (`KEYCLOAK_*`). Start IdP with:

```bash
docker compose --profile auth up -d
# realm jungle-gaming · client wagering-api · user provider-bot / provider-bot
```

Health/metrics stay `@Public`. Auth remains **0 points** on the official scoring table.

## Differentials (§14 + optional)

- Load: `bun run test:load` / `report:system` — p50/p95/p99, outbox lag, hot-wallet honesty
- Chaos: `bun run test:chaos` — TX abort, inbox atomic claim, network fail-closed
- Multi-instance: `docker compose --profile multi-instance up -d` → gateway **:8088**
- Observability UI: `docker compose --profile obs up -d` → Grafana **:3005** (admin/admin)
- Auth IdP: `docker compose --profile auth up -d` + `AUTH_MODE=oidc`

## Docs

- [ARCHITECTURE.md](./ARCHITECTURE.md) — ADRs, schema, trade-offs
- [docs/LOAD.md](./docs/LOAD.md) — load-test methodology
- [docs/OPS_RUNBOOK.md](./docs/OPS_RUNBOOK.md) — RPO/RTO, multi-instance, OTLP, chaos
- Generate timing report: `bun run report:system` → `docs/SYSTEM_REPORT.{json,md}` (gitignored)
- [AGENTS.md](./AGENTS.md) — engineering contract for agents

## Implementation roadmap

| Phase | Status |
|---|---|
| 0 Scaffold + health + domain skeleton | **done** |
| 1 Domain unit suite (Money/Wallet/Tx/Ledger) | **done** |
| 2 Schema + reversible migrations | **done** |
| 3 ProcessWager + HTTP wallets/wagers | **done** |
| 3.1 MikroORM UnitOfWork + FOR UPDATE | **done** |
| 5 REFUND/ROLLBACK + PENDING_REFERENCE worker | **done** |
| 6 SQS consumer + inbox + DLQ | **done** |
| 7 Outbox publisher SKIP LOCKED | **done** |
| 8 Concurrency suite (≥3 instances) | **done** |
| 9 Observability + docs polish | **done** |
| 10 Optional: Keycloak / load test | **done** (Keycloak profile + JWKS + load + system report) |
