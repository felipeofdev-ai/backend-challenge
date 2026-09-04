# ARCHITECTURE.md — Wagering Processor

## 1. Vision

Single bounded context service that processes provider wager operations (`BET → WIN | LOSS | REFUND | ROLLBACK`) with financial invariants under at-least-once messaging and multi-instance deployment.

**One business path:** HTTP and SQS both call `ProcessWagerUseCase`.

**Database is the source of truth.** SQS FIFO is an optimization (ordering / reduced dupes), never the consistency guarantee.

## 2. Module layout

```
src/
  wagering/domain/          # pure DDD — no NestJS / MikroORM
  wagering/application/     # use cases + ports
  messaging/domain/         # InboxMessage, OutboxMessage, IntegrationEvent
  shared/                   # ids, canonical hash, config
  infrastructure/           # HTTP, auth, ORM, SQS, observability
```

## 3. ADRs

### ADR-001 — Money: decimal.js, fixed scale 2, no silent rounding

- Inputs with >2 fractional digits → `INVALID_MONEY` (never round).
- Persistence: `NUMERIC(38,2)` + `CHAR(3)` currency columns.
- Rationale: silent rounding hides provider contract violations.

### ADR-002 — Concurrency: pessimistic lock per wallet

- `SELECT … FROM wallets WHERE id = $1 FOR UPDATE` inside the financial transaction.
- Unit of concurrency = `walletId` (challenge §8).
- `version` increments only on balance change (observability + API contract), not the primary conflict mechanism.
- Trade-off: serializes a hot wallet; transactions stay short (no external I/O inside TX). `lock_timeout` + limited retry for lock wait.

Why not optimistic-only: race `2×80 on 100` becomes retry-order dependent; 50× same bet produces lock-noise. Pessimistic lock makes the required scenario deterministic.

### ADR-003 — Persistent idempotency

- `UNIQUE (provider_id, idempotency_key)`
- `payload_hash` = SHA-256 of canonical business JSON
- `result_balance` snapshot for faithful replay (including LOSS)

### ADR-004 — Transactional outbox

- Events inserted in the **same** SQL transaction as wallet/ledger/tx/inbox.
- Publisher: `FOR UPDATE SKIP LOCKED` + exponential backoff.
- At-least-once publish; consumers dedupe by `eventId`.

### ADR-005 — Inbox for SQS redelivery

- `PRIMARY KEY (consumer_name, message_id)` using envelope `messageId`.
- Ack only after commit.

### ADR-006 — Out-of-order references

- Missing reference → `PENDING_REFERENCE` + scheduled worker (backoff, max 10 attempts or 24h TTL).
- Exhausted → `REJECTED` / `REFERENCE_NOT_FOUND`.
- SQS message is acked when pending is persisted (redelivery cannot create the missing reference).

### ADR-007 — Single effective reversal per reference

README §7.4 literal: a reference cannot be reversed twice *by the same operation type*
(i.e. two `REFUND`s or two `ROLLBACK`s). We **tighten** that to: at most one processed
`REFUND` **or** `ROLLBACK` per referenced transaction — otherwise `BET → REFUND` then
`BET → ROLLBACK` would double-credit the same stake and break the global credit invariant.

- Enforced by partial unique index `uq_reversal_ref_unique` + domain check
- Limitation: rolling back a REFUND is out of scope; document manual adjustment path

### ADR-008 — LOSS does not change balance or version

### ADR-009 — `rehydrate` skips transition rules; ledger rehydrate still checks arithmetic

### ADR-010 — HTTP synchronous by default; `202` only for `PENDING_REFERENCE`

### ADR-011 — Auth is an extension point (0 scoring points)

- `AuthGuard` (`static` | `oidc`) + `ProviderIdentityPort` (wired; default accepts any providerId)
- Keycloak via compose profile `auth` when `AUTH_MODE=oidc`

### ADR-011b — `PERSISTENCE=memory` is a unit-test double only

- Default is always `postgres`. In-memory UoW exists for fast domain/application unit tests.
- Boot refuses `PERSISTENCE=memory` when `NODE_ENV=production`.

### ADR-012 — Observability

- pino JSON logs; Prometheus `/metrics`; `/health/ready` probes PG + SQS
- `POST /wallets/:id/reconciliation` persists `reconciliation_checks` and returns divergence

### ADR-013 — Auth / Keycloak (0 scoring points)

- Default `AUTH_MODE=static` for evaluation; health/metrics remain `@Public`
- `AUTH_MODE=oidc` verifies Bearer JWT via JWKS (`jose` + `OidcTokenVerifier`)
- Compose profile `auth` runs Keycloak 26 with realm `jungle-gaming` / client `wagering-api`
- Domain provider identity stays on `ProviderIdentityPort`, never inside AuthGuard

### ADR-014 — Concurrent unique races retry in a fresh SQL TX

- Unique violations abort the PostgreSQL transaction; the use case retries `execute` up to 3 times
- Covers idempotency races and ADR-007 reversal unique indexes without leaving orphan 500s

### ADR-015 — `chk_ref_required` is implication, not boolean equality

- Forensic suite found original CHECK rejected `WIN` with optional `reference_external_transaction_id`
- Fixed in `Migration20260903220000`: REFUND/ROLLBACK require reference; other kinds may include one

### ADR-016 — Packaging for multi-instance demo

- `Dockerfile` + Compose profiles `app` and `multi-instance` (3 API processes)
- Postgres tuned for lock visibility (`log_lock_waits`, `lock_timeout`)
- Typed `loadConfig()` fail-fast; CI workflow `.github/workflows/quality.yml`
- Biome lint gate (`bun run lint`) with Nest parameter-decorator support
- SQS integration E2E uses an isolated FIFO queue so a local worker cannot steal messages

### ADR-017 — SQS inbox participates in the financial SQL TX

- `ProcessWagerUseCase.executeFromQueue` claims inbox, applies wallet/ledger/outbox, and
  `markProcessed` in **one** `uow.transactional` (README §6.5 / §11).
- Inbox raw SQL **must** use `em.execute(...)` (transaction-aware). Never `em.getConnection().execute(...)`,
  which can borrow a different pool connection and commit outside the financial TX.
- Transient errors roll back the inbox insert → redelivery can reclaim.
- Non-retryable domain errors mark inbox processed inside the same TX, then ack.
- Ack SQS only after that commit returns.
- `in_flight` (unprocessed inbox held by another worker): consumer does **not** release visibility,
  so peers cannot race an in-progress claim; visibility timeout recovers if the holder dies.

### ADR-018 — Restart recovery + load percentiles + OpenAPI

- `tests/concurrency/restart-recovery.test.ts`: SIGKILL after commit (pre-ack), outbox drain after
  process death, inbox redelivery after graceful-stop simulation.
- Load harness emits `latencyMs.{p50,p95,p99,max}` and `outboxLagMessages` (see `docs/LOAD.md`).
- Swagger UI at `/docs` for evaluator UX (auth still extension-point / 0 scoring points).

### ADR-019 — OTel spans, SLO gauges, chaos suite, system report

- HTTP ProcessWager wrapped in `withWagerSpan` (`@opentelemetry/api`) + `durationMs` structured logs
- Prometheus: `wager_slo_latency_under_250ms_ratio`, `dependency_probe_failures_total`
- `/health/ready` increments probe failure counters on PG/SQS down
- `tests/chaos`: SQS unreachable fail-closed; inbox TX rollback + redelivery; wallet/ledger/outbox atomicity
- `bun run report:system` → `docs/SYSTEM_REPORT.{json,md}` with per-kind latency percentiles

### ADR-020 — Optional elevations that stay README-safe

Gate vs official challenge README:

| Improvement | Verdict | Why |
|---|---|---|
| OTLP exporter | **allowed** | §12 explicitly says OpenTelemetry is optional |
| Network chaos / Toxiproxy profile | **allowed** | §13 wants failure coverage; Toxiproxy is optional tooling |
| Multi-AZ / RPO-RTO runbook | **allowed** | documentation only (`docs/OPS_RUNBOOK.md`) |
| Queue-first HTTP `202` as **default** | **would violate** | §9 example is sync `PROCESSED` + balance; ADR-010 |
| `WAGER_HTTP_MODE=enqueue` opt-in | **allowed** | default remains `sync`; §9 status mapping allows pending accept |

Implemented:

- `startOtelIfConfigured()` when `OTEL_EXPORTER_OTLP_ENDPOINT` is set
- Compose profile `chaos` (Toxiproxy) + automated chaos without it
- `docs/OPS_RUNBOOK.md` RPO/RTO
- `EnqueueWagerUseCase` + `WAGER_HTTP_MODE=enqueue` → `202 PENDING` (worker still owns financial TX)
- PG pool `DATABASE_POOL_MIN/MAX` for parallel wallet throughput

### ADR-021 — Atomic inbox claim + multi-instance gateway + obs stack

- Inbox `tryReceive` uses `INSERT … ON CONFLICT DO NOTHING RETURNING` (no SELECT-then-INSERT race)
- Same `messageId` + divergent `payloadHash` → `IDEMPOTENCY_CONFLICT` (never silent reprocess)
- Compose `gateway` (nginx least_conn) in front of `api-1..3` on `:8088`
- Compose profile `obs`: Prometheus + Grafana provisioned dashboard (`observability/`)
- Worker `DlqDepthPoller` → `sqs_dlq_depth` gauge

### ADR-022 — PG error taxonomy, ledger bidirectional invariant, hexagonal ports

- Postgres `55P03` / serialization / unavailable → `LockTimeoutError` / `DEPENDENCY_UNAVAILABLE` → HTTP **503**
- Lock wait + unique races retry via `ProcessMetricsPort` (Prometheus stays outside use cases)
- SQS consumer: canonical inbox `payloadHash`; release visibility on transient failure / shutdown race; ack permanent domain errors
- DEFERRABLE constraint trigger: PROCESSED balance-affecting tx must have a ledger row
- `WagerQueuePort` for enqueue mode; pino redact; filter never leaks SQL to clients
- Money hydrate refuses scale >2 (never silent truncate on read)

### ADR-023 — Pool saturation, reversal FK, in_flight → DLQ path

**Pool saturation**

- `DATABASE_POOL_MAX` (default 20) + `DATABASE_POOL_ACQUIRE_MS` (default 5000): under
  exhaustion, Tarn fail-closed → `DependencyUnavailableError` → HTTP **503** (never hang).
- Per-TX `SET LOCAL lock_timeout` (default `LOCK_TIMEOUT_MS=2000`) so hot-wallet waits do not
  pin pool slots forever; retries stay bounded (`LOCK_RETRY_MAX`).
- Sizing rule of thumb: `POOL_MAX ≥ (API_instances + workers) × concurrent_msgs_per_process + 2`.
- Evidence: `tests/forensic/pool-saturation.test.ts`, `tests/unit/shared/pg-error.test.ts`.

**Reversal `reference_transaction_id`**

- Domain: `markProcessed` refuses REFUND/ROLLBACK without `referenceTransactionId`.
- DB: `chk_processed_reversal_has_ref` — PROCESSED REFUND/ROLLBACK require non-null FK.
  Needed because PostgreSQL unique indexes treat `NULL` as distinct, so
  `uq_reversal_ref_unique` alone would allow two PROCESSED reversals with NULL ref.
- Evidence: domain unit + `tests/forensic/postgres-constraints.test.ts`.

**`in_flight` visibility → DLQ**

- `in_flight` = peer holds an **uncommitted** inbox INSERT (ON CONFLICT sees it; row not
  readable yet). Same-TX design: peer crash → claim rolls back → next delivery proceeds.
- Consumer calls `deferWagerVisibility(IN_FLIGHT_VISIBILITY_SECONDS)` (default **5**): not
  ack, not release-to-0 (thundering herd), not silent full-30s wait.
- `ApproximateReceiveCount` increments per `ReceiveMessage`. Path to DLQ only if the message
  keeps being received across `maxReceiveCount` windows (poison / stuck peer longer than
  `maxReceiveCount × backoff`). Size RedrivePolicy vs p99 TX time; ops redrive DLQ after fix.
- Evidence: `tests/unit/infrastructure/wager-consumer.inflight.test.ts`, ADR-017.

### Transaction status transitions (domain)

| From | Event | To |
|---|---|---|
| _(new)_ | open + apply success | `PROCESSED` |
| _(new)_ | open + domain reject | `REJECTED` |
| _(new)_ | missing reference | `PENDING_REFERENCE` |
| `PENDING_REFERENCE` | reference arrives / worker | `PROCESSED` or `REJECTED` |
| `PROCESSED` / `REJECTED` | — | terminal (immutable business outcome) |

`rehydrate` does **not** re-validate these transitions (ADR-009).

## 4. Failure codes (summary)

| Code | HTTP | Action |
|---|---|---|
| `INVALID_MONEY` / validation | 400 | Fix payload |
| `IDEMPOTENCY_CONFLICT` | 409 | Do not retry as-is |
| `INSUFFICIENT_BALANCE` | 422 | Top-up or abandon |
| `REFUND_WOULD_OVERDRAW` / `ROLLBACK_WOULD_OVERDRAW` | 422 | Distinct from insufficient bet |
| `REFERENCE_ALREADY_REVERSED` | 422 | Abandon |
| `REFERENCE_NOT_FOUND` | 422 (after TTL) | Or wait/resubmit earlier |
| `DEPENDENCY_UNAVAILABLE` / `LOCK_TIMEOUT` | 503 | Retry with backoff |

## 5. Known limits

| Limit | Why | Evolution |
|---|---|---|
| One reversal per reference | Protect global credit invariant | Explicit void operation |
| No full double-entry | Optional differential | Debit/credit accounts |
| WIN reference optional | Challenge wording | Round completeness rules |
| Auth static default | Scoring table (0 pts) | `AUTH_MODE=oidc` + profile `auth` |
| Sync HTTP | Eval UX (§9 example) | Opt-in `WAGER_HTTP_MODE=enqueue` only |
| One reversal across REFUND+ROLLBACK | README §7.4 is per-kind; we tighten to one credit total (ADR-007) | Explicit void op if both kinds needed |
| `PERSISTENCE=memory` | Unit-test double only (default is `postgres`) | Refuse boot when `NODE_ENV=production` |

## 6. Presentation answers (cheat sheet)

1. **Why pessimistic?** Deterministic hot-wallet correctness; version stays for API/events.
2. **Crash after commit before ack?** Redelivery → inbox/idempotency → no duplicate effect.
3. **Two concurrent REFUNDs?** Wallet lock + partial unique index.
4. **Why not only FIFO?** Broker is optimization; DB constraints are the proof.
5. **Replay balance?** `result_balance` snapshot at process time.
6. **Inbox same TX?** `em.execute` inside `em.transactional` (never `getConnection().execute`). Forensic: claim disappears after rollback (`tests/forensic/inbox-same-tx.test.ts`).
7. **Pool saturation?** `acquireTimeoutMillis` + `lock_timeout` → `DEPENDENCY_UNAVAILABLE` / `LOCK_TIMEOUT` → **503**. Formula in ADR-023.
8. **Reversal with null `reference_transaction_id`?** Domain refuses + `chk_processed_reversal_has_ref` (NULLs bypass unique indexes in PG).
9. **`normalizeDecimal`?** Refuses scale >2 on read — never silent truncate.
10. **`in_flight` → DLQ?** Defer visibility (default 5s). Peer crash rolls back claim. DLQ only after `maxReceiveCount` receives; RedrivePolicy sized vs p99; ops redrive.

## 7. Eliminatory failures audit (§14 killers → proof)

| Killer criterion | Guard | Evidence |
|---|---|---|
| `number` for money | `Money` + `decimal.js`; `NUMERIC(38,2)` | `tests/unit/domain/money.test.ts`, forensic money |
| Negative balance via race | `FOR UPDATE` + `CHECK (balance >= 0)` | concurrency §8 + forensic PG |
| Duplicate debit/credit | unique idempotency + inbox PK + reversal partial unique | forensic I1/I2, 50× same bet |
| Idempotency only in memory | Postgres unique indexes | migrations + forensic |
| Correct only with 1 instance | ≥3 OS harness + multi-instance compose + gateway | `test:concurrency` / `test:concurrency:harness` |
| Event before commit | outbox insert in same SQL TX | ADR-004/017, chaos atomicity |
| No auditable ledger | immutable ledger + trigger | forensic trigger test |
| Mock-only PG/SQS in int tests | real containers | `tests/integration`, `tests/concurrency` |

## 8. Delivery notes

Evaluation evidence lives in ADRs above, `tests/{unit,forensic,concurrency,integration,load,chaos}`, and `bun run report:system`. Auth/OIDC remains an extension point (0 scoring points per challenge §14).
