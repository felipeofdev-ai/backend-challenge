# Wagering Processor — Desafio Jungle Gaming

Processador distribuído de apostas: correção financeira sob entrega *at-least-once*, concorrência multi-instância e recuperação após crash.

**Stack:** Bun 1.x · TypeScript strict · NestJS 11 · MikroORM 6 · PostgreSQL 16 · LocalStack SQS FIFO

Repositório de entrega (fork público): solução completa do [junglegaming/backend-challenge](https://github.com/junglegaming/backend-challenge).

---

## Pré-requisitos

- [Bun](https://bun.sh) 1.x
- Docker + Docker Compose
- Portas livres: `3000` (API), `5433` (Postgres), `4566` (LocalStack)

---

## Passo a passo (do zero)

```bash
# 1. Dependências
bun install

# 2. Variáveis de ambiente
cp .env.example .env

# 3. Infra local (Postgres 16 + LocalStack SQS FIFO + DLQ)
docker compose up -d

# 4. Schema (migrations reversíveis)
bun run migration:up

# 5. Checagens estáticas
bun run typecheck
bun run lint

# 6. API (HTTP síncrono — padrão do desafio §9)
bun run dev
# → http://localhost:3000
# → Swagger: http://localhost:3000/docs

# 7. Worker (em outro terminal): consumer SQS + outbox + PENDING_REFERENCE
bun run worker
```

Postgres do desafio escuta em **:5433** (evita conflito com PostgreSQL local em `:5432`).

### Smoke checks

```bash
curl http://localhost:3000/health/live
curl http://localhost:3000/health/ready   # sonda PostgreSQL + SQS
curl http://localhost:3000/metrics        # Prometheus text
```

### Exemplo mínimo (wallet + BET)

```bash
# Criar wallet
curl -s -X POST http://localhost:3000/wallets \
  -H 'Content-Type: application/json' \
  -d '{"playerId":"11111111-1111-7111-8111-111111111111","initialBalance":{"amount":"100.00","currency":"BRL"}}'

# Processar BET (substitua <walletId>)
curl -s -X POST http://localhost:3000/wagers \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: demo:bet-1' \
  -d '{
    "providerId":"demo",
    "externalTransactionId":"bet-1",
    "playerId":"11111111-1111-7111-8111-111111111111",
    "walletId":"<walletId>",
    "roundId":"round-1",
    "gameId":"fortune-chimp",
    "kind":"BET",
    "money":{"amount":"10.00","currency":"BRL"}
  }'

# Reconciliação
curl -s -X POST http://localhost:3000/wallets/<walletId>/reconciliation
```

---

## Garantias (invariantes)

| Invariante | Como é garantida |
|---|---|
| Sem débito/crédito duplicado | `UNIQUE (provider_id, idempotency_key)` + ledger `UNIQUE (transaction_id)` + inbox |
| Saldo nunca negativo | `SELECT … FOR UPDATE` + `CHECK (balance >= 0)` |
| Eventos confirmados não se perdem | Outbox transacional (mesma TX SQL) |
| Ledger imutável | Trigger no banco bloqueia UPDATE/DELETE |
| Correto com N instâncias | Lock pessimista por `walletId` + suíte de concorrência |

---

## Testes (o que o avaliador deve rodar)

Com a infra no ar (`docker compose up -d` + `migration:up`):

```bash
bun test                      # unidade
bun run test:forensic         # invariantes + constraints do schema
bun run test:concurrency      # races reais no Postgres + ≥3 processos OS
bun test tests/integration    # SQS E2E (fila FIFO isolada; PG + LocalStack)
bun run test:load             # carga sustentada + harness
bun run test:chaos            # resiliência / atomicidade
bun run lint
bun run test:all              # suítes em sequência (evita contenção no PG compartilhado)
bun run test:concurrency:harness   # ≥3 processos OS na mesma wallet
```

Invariante final em todo teste que mexe em saldo:

```
wallet.balance == Σ(créditos do ledger) − Σ(débitos do ledger)
```

---

## Multi-instância (Docker)

```bash
docker compose --profile app up -d --build              # 1 API + worker
docker compose --profile multi-instance up -d --build   # APIs :3000/:3001/:3002 + worker
# Gateway (least_conn): http://localhost:8088
```

Postgres ajustado para visibilidade de locks (`log_lock_waits`, `lock_timeout`). Ver ADR-016.

---

## Observabilidade

- **Logs:** pino JSON (`LOG_LEVEL`, `APP_NAME`) + `durationMs` / spans OTel em ProcessWager
- **Métricas:** `GET /metrics` — contadores wager/outbox/SQS, `wager_slo_latency_under_250ms_ratio`, `dependency_probe_failures_total`
- **Ready:** `503` se PostgreSQL ou SQS indisponível (`PERSISTENCE=memory` é double de unit test; default é Postgres)
- **Relatório:** `bun run report:system` → `docs/SYSTEM_REPORT.{json,md}` (gitignored)

UI opcional:

```bash
docker compose --profile obs up -d
# Grafana :3005 (admin/admin) · Prometheus :9090
```

---

## Algoritmo `payloadHash`

1. Subconjunto de negócio: `providerId`, `externalTransactionId`, `walletId`, `playerId`, `roundId`, `gameId`, `kind`, `money`, opcional `referenceExternalTransactionId`
2. Normalizar `money.amount` para exatamente 2 casas decimais
3. Ordenar chaves lexicograficamente (recursivo); omitir `undefined`
4. `JSON.stringify` (sem espaços) → SHA-256 hex

Header `Idempotency-Key`, `messageId` e metadados de transporte **não entram** no hash.

Mesma chave + mesmo hash → replay idempotente. Mesma chave + hash diferente → `409 IDEMPOTENCY_CONFLICT`.

---

## Auth (0 pontos na tabela oficial)

- `AUTH_MODE=static` (default): ponto de extensão via `AuthGuard` + `ProviderIdentityPort`
- `AUTH_MODE=oidc`: JWT verificado no JWKS do Keycloak (`KEYCLOAK_*`)

```bash
docker compose --profile auth up -d
# realm jungle-gaming · client wagering-api · user provider-bot / provider-bot
```

Health e metrics permanecem `@Public`.

---

## Diferenciais (§14 + opcionais)

| Diferencial | Como exercitar |
|---|---|
| Carga | `bun run test:load` / `report:system` — p50/p95/p99, outbox lag |
| Chaos | `bun run test:chaos` — abort de TX, claim atômico do inbox, fail-closed de rede |
| Multi-instância | profile `multi-instance` + gateway `:8088` |
| Observabilidade UI | profile `obs` → Grafana `:3005` |
| Auth IdP | profile `auth` + `AUTH_MODE=oidc` |

---

## Documentação

| Arquivo | Conteúdo |
|---|---|
| [ARCHITECTURE.md](./ARCHITECTURE.md) | ADRs, schema, trade-offs, limitações, respostas de apresentação |
| [docs/LOAD.md](./docs/LOAD.md) | Metodologia de carga |
| [docs/OPS_RUNBOOK.md](./docs/OPS_RUNBOOK.md) | RPO/RTO, pool, `in_flight` → DLQ, multi-instância, OTLP |
| [AGENTS.md](./AGENTS.md) | Contrato de engenharia do repositório |

---

## Roadmap de implementação

| Fase | Status |
|---|---|
| 0 Scaffold + health + esqueleto de domínio | **feito** |
| 1 Suíte unitária de domínio (Money/Wallet/Tx/Ledger) | **feito** |
| 2 Schema + migrations reversíveis | **feito** |
| 3 ProcessWager + HTTP wallets/wagers | **feito** |
| 3.1 MikroORM UnitOfWork + `FOR UPDATE` | **feito** |
| 5 REFUND/ROLLBACK + worker PENDING_REFERENCE | **feito** |
| 6 Consumer SQS + inbox + DLQ | **feito** |
| 7 Outbox publisher `SKIP LOCKED` | **feito** |
| 8 Suíte de concorrência (≥3 instâncias) | **feito** |
| 9 Observabilidade + docs | **feito** |
| 10 Opcional: Keycloak / carga | **feito** |

---

## Comandos úteis

| Comando | Função |
|---|---|
| `bun run dev` | API em watch |
| `bun run worker` | Consumer SQS + outbox + pending-reference |
| `bun run migration:up` / `migration:down` | Migrar / reverter |
| `bun run test:all` | Suíte completa |
| `bun run docker:multi` | Multi-instância Compose |
| `bun run report:system` | Relatório de latência/atomicidade |
