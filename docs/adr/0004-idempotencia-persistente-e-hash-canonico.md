# ADR 0004 — Garantir idempotência no PostgreSQL por chave e hash canônico

- Status: Aceita
- Data: 2026-10-23

## Contexto

A entrega é at-least-once: uma solicitação pode chegar por HTTP e SQS mais de uma vez, inclusive após uma queda entre commit e ack. Memória de processo e deduplicação FIFO não são garantias suficientes.

## Decisão

Persistir a identidade da operação em `wager_transactions`. O banco impõe unicidade para `idempotency_key` e para `(provider_id, external_transaction_id)`.

Calcular `payload_hash` com SHA-256 de JSON canônico: chaves dos campos de negócio ordenadas alfabeticamente e `money` serializado como `amount` e `currency`. A chave do header não participa do payload hash. Em uma nova requisição, a idempotência é consultada antes da busca da wallet: payload igual retorna o resultado persistido com `idempotentReplay: true`; payload distinto gera conflito mesmo que o payload divergente aponte para uma wallet inexistente. O reprocessamento interno de `PENDING_REFERENCE` identifica a transação pelo seu id e não passa por esse replay. O leitor também aceita o hash legado para não invalidar operações já gravadas antes da canonização atual.

## Consequências

- Retry não duplica débito, crédito ou evento de negócio.
- Replays devolvem o `result_balance` observado pela operação original quando disponível.
- A unicidade global de `idempotency_key` requer que provedores não reutilizem uma mesma chave; a convenção recomendada é `{providerId}:{externalTransactionId}`.

## Referências

- `src/modules/wagering/process-wager-transaction.service.ts`
- `src/infrastructure/database/migrations/Migration20261021220000.ts`
- `src/infrastructure/database/migrations/Migration20261022230000.ts`
