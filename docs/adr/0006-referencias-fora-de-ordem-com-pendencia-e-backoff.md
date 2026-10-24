# ADR 0006 — Tratar referências fora de ordem como pendência persistida

- Status: Aceita
- Data: 2026-10-23

## Contexto

`REFUND` e `ROLLBACK` dependem de outra operação, e um `WIN` pode opcionalmente referenciar uma `BET`. A fila não garante que a referência seja entregue antes do dependente.

## Decisão

Quando a referência está ausente ou ainda não terminal, persistir a transação como `PENDING_REFERENCE`, sem alterar o saldo, e inserir o evento de pendência na outbox. Um worker busca pendências vencidas por `next_reference_attempt_at`, aplica backoff exponencial limitado a 300 segundos e tenta novamente.

Cada passagem para `PENDING_REFERENCE` incrementa o contador de tentativas. Quando ele chega a oito, a próxima execução agendada termina a operação como `REJECTED` com `REFERENCE_NOT_FOUND`. Ao encontrar a referência, validar provider, jogador, wallet, moeda, rodada, tipo elegível, valor integral e reversão única. As transações `PROCESSED`, `REJECTED` e `FAILED` são terminais.

## Consequências

- A ordem de chegada não determina a correção financeira.
- Pendências são auditáveis e sobrevivem a reinicializações.
- Uma referência que não chega dentro da política definida precisa ser reenviada como uma nova operação válida, não mutada depois de rejeitada.

## Referências

- `src/modules/wagering/wager-transaction.ts`
- `src/modules/wagering/process-wager-transaction.service.ts`
- `src/modules/wagering/wager-worker.service.ts`
- `src/infrastructure/database/migrations/Migration20261022210000.ts`
