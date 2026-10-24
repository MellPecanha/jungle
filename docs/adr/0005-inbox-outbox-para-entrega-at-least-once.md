# ADR 0005 — Usar Inbox e Transactional Outbox para mensageria at-least-once

- Status: Aceita
- Data: 2026-10-23

## Contexto

O commit no PostgreSQL e a publicação/remoção de mensagens SQS não compartilham uma transação distribuída. O processo pode morrer depois do commit, antes da publicação ou antes do ack; tanto comandos quanto eventos podem ser entregues mais de uma vez.

## Decisão

Para comandos recebidos do SQS, registrar `InboxMessage` por `(consumer_name, message_id)` na mesma transação da operação financeira e confirmar a mensagem somente depois do commit.

O envelope de comando exige `messageId`, `type`, `occurredAt` ISO-8601 e `data`. Envelope inválido é encaminhado à DLQ. Erros técnicos permanentes conhecidos, atualmente SQLSTATE `0A*` e `42*` (recurso SQL não suportado, schema, sintaxe ou autorização/configuração), recebem também um registro `FAILED` com `INTERNAL_ERROR`, quando o banco permanece capaz de gravar a auditoria; erros transitórios seguem o caminho de retry.

Para eventos, inserir `OutboxMessage` na mesma transação que a alteração financeira. Publishers concorrentes selecionam um evento pendente com `FOR UPDATE SKIP LOCKED`, publicam-no na fila FIFO e marcam-no como publicado; em falha, registram tentativa e agendam backoff. Consumidores de eventos devem deduplicar por `eventId`.

## Consequências

- Não há evento confirmado perdido por queda após o commit.
- A publicação é pelo menos uma vez, portanto duplicatas são um comportamento esperado e seguro.
- A transação/lock da outbox fica aberta durante a chamada ao SQS; indisponibilidade ou lentidão do broker eleva a ocupação da conexão e do lock.

## Referências

- `src/modules/idempotency/inbox-message.ts`
- `src/modules/wagering/wager-consumer.service.ts`
- `src/infrastructure/messaging/outbox-message.ts`
- `src/infrastructure/messaging/outbox-publisher.service.ts`
