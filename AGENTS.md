# AGENTS.md — Contrato de Engenharia (wagering-processor)

Contrato inviolável para agentes e humanos neste repositório.
Baseado no desafio [junglegaming/backend-challenge](https://github.com/junglegaming/backend-challenge).

## Stack (fixa)

- Runtime / PM / test runner: **Bun 1.x** (`bun`, `bun test`, `bunx`)
- Linguagem: TypeScript **strict** (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`)
- Framework: **NestJS 11** (DI, modules; lógica de negócio **proibida** em controllers)
- ORM: **MikroORM 6** (`em.transactional()`, `LockMode.PESSIMISTIC_WRITE`)
- Banco: PostgreSQL 16 via Docker Compose
- Mensageria: AWS SQS via LocalStack (FIFO + DLQ)
- Migrações: versionadas com `up()` e `down()` reversíveis

## Regras invioláveis (falha eliminatória)

1. **NUNCA** use `number` / `float` / `double` para dinheiro. Use `Money` (`decimal.js`) + string `"25.00"` nas fronteiras + `NUMERIC(38,2)` no banco.
2. **NUNCA** use cache em memória como garantia de idempotência. Dedup = índice único no Postgres.
3. **NUNCA** publique evento antes do commit. Eventos só via `outbox_messages` na **mesma** transação SQL.
4. **NUNCA** sobrescreva/exclua lançamento do ledger. Imutabilidade via **trigger** no banco.
5. **NUNCA** use lock global. Unidade de concorrência = `walletId` (lock por linha).
6. **NUNCA** implemente saldo como read → calculate → update sem controle. Sempre `SELECT … FOR UPDATE` antes de calcular.
7. **NUNCA** confie apenas em SQS FIFO. Fila é otimização; invariantes moram no banco.
8. Todo efeito financeiro é atômico: tx + wallet + ledger + inbox (se SQS) + outbox na **MESMA** TX SQL.
9. Ack SQS **somente** após commit.
10. Testes de integração/concorrência usam containers reais — sem mocks de PG/SQS.

## Arquitetura

```
src/
  wagering/
    domain/          # zero NestJS/ORM
    application/     # use cases + ports
    infrastructure/  # adapters (HTTP, MikroORM, SQS)
  messaging/
  shared/
  infrastructure/
```

- Hexagonal + DDD
- Aggregates: `private constructor` + `create`/`open`/`rehydrate`
- `rehydrate` **não** revalida transições de negócio
- IDs: UUID v7 gerados na aplicação
- Auth: guard no-op (`AUTH_MODE=static`) + `ProviderIdentityPort` (0 pontos na avaliação)

## Invariantes globais

- Não duplicar créditos
- Não duplicar débitos
- Não perder eventos confirmados
- Nunca permitir saldo negativo

## Comandos

```bash
bun install
docker compose up -d
bun run migration:up
bun run dev          # API
bun run worker       # SQS consumer + outbox + pending-reference
bun test             # unit
bun run test:integration
bun run test:concurrency
bun run test:concurrency:harness  # ≥3 OS processes
```

Observabilidade: `GET /health/ready`, `GET /metrics`, `POST /wallets/:id/reconciliation`.

## Como trabalhar

- Commit por fase com testes verdes
- Migração sempre com `down()`
- Mudança de regra de negócio = teste + atualização do `ARCHITECTURE.md`
- Dependência nova exige justificativa no `ARCHITECTURE.md`
