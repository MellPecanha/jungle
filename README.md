# Jungle Gaming Wagering Processor

Processador financeiro distribuído para operações de apostas, construído com NestJS, Bun, PostgreSQL, MikroORM e SQS compatível via LocalStack.

## Requisitos

- Bun 1.x
- Docker e Docker Compose

## Configuração local

```bash
bun install
cp .env.example .env  # somente se ainda não existir um .env
docker compose up -d
bun run migration:up
```

O PostgreSQL local é publicado em `localhost:5434` para evitar conflitos com outros projetos. O LocalStack usa `localhost:4566`.

## Organização do código

- `src/modules/wallets`, `wagering`, `ledger` e `idempotency`: casos de uso e domínio por responsabilidade.
- `src/infrastructure/database`: configuração do MikroORM e migrations; `src/infrastructure/messaging`: cliente SQS e outbox.
- `src/config`: configuração compartilhada; `src/common`: dinheiro, eventos, autenticação e observabilidade compartilhados.
- `test`: testes unitários, de integração, ponta a ponta e processos auxiliares.
- `docker-compose.yml` e `.env.example`: serviços e configuração local.

Não há módulo de webhooks: o processamento externo usa HTTP e SQS.

## Comandos

```bash
bun run start:dev
bun test
bun run test:e2e
RUN_INTEGRATION=true bun test test/financial.integration.spec.ts
RUN_INTEGRATION=true bun test test/messaging.integration.spec.ts
bun run build
bun run lint
bun run migration:up
bun run migration:down
```

## Princípios financeiros

- Valores monetários são strings decimais com duas casas e usam `Decimal`.
- Wallet, transação financeira, ledger e outbox devem ser confirmados na mesma transação PostgreSQL.
- Unicidade, saldo não negativo e aritmética do ledger são protegidos também por constraints do banco.
- A concorrência é serializada por wallet, nunca por um lock global.
- A idempotência é persistida no PostgreSQL; memória e FIFO são apenas otimizações.

## Serviços locais

```bash
docker compose ps
curl http://localhost:3000/health/live
```

Filas:

- `wager-transactions.fifo`
- `wager-transactions-dlq.fifo`
- `wager-events.fifo`

O teste de mensageria cria e remove seu próprio schema e filas de teste. O teste financeiro usa o schema padrão do banco configurado e deixa registros de teste; utilize um banco de desenvolvimento ou de teste dedicado. O endpoint `GET /metrics` mostra métricas locais de cada processo e dados agregados do banco.

Os workers iniciam com a aplicação; defina `WORKERS_ENABLED=false` para desativá-los. O teste de integração cria wallets e transações de teste no banco configurado.

## Autenticação

Autenticação externa não foi incluída no timebox. O ponto de extensão é o boundary HTTP, onde um guard OIDC pode ser adicionado sem alterar o domínio financeiro. Health checks permanecem públicos e mensagens da fila são consideradas canal interno.

## Swagger

Com a aplicação em execução, acesse `http://localhost:3000/docs` (ou a porta definida em `PORT`). A interface permite consultar e executar os endpoints. Para submeter uma aposta, informe `Idempotency-Key` em **Parameters** e envie o JSON em **Request body**.

## Arquitetura

Decisões, invariantes, concorrência, Inbox/Outbox e limitações estão descritas em [ARCHITECTURE.md](./ARCHITECTURE.md).
