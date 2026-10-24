# ADR 0002 — Materializar saldo com ledger imutável no mesmo commit

- Status: Aceita
- Data: 2026-10-23

## Contexto

O desafio exige que saldo materializado e ledger sejam consistentes, que lançamentos sejam auditáveis e que eventos confirmados não se percam. Uma alteração parcial deixaria um saldo sem evidência, ou uma evidência sem saldo correspondente.

## Decisão

Para toda movimentação que afeta saldo, gravar na mesma transação PostgreSQL:

1. a transação de aposta;
2. o novo saldo e a versão da wallet;
3. exatamente um lançamento no ledger; e
4. os eventos pendentes na outbox.

O saldo inicial é uma transação interna `OPENING`, com crédito no ledger. O ledger é append-only: uma trigger do banco bloqueia `UPDATE` e `DELETE`; correções futuras devem ser novos lançamentos compensatórios.

O schema mantém a defesa em profundidade: saldo de wallet não negativo, uma wallet por jogador/moeda, um lançamento por transação, aritmética `before ± amount = after` e valores de saldo do lançamento não negativos.

## Consequências

- O saldo é rápido para leitura e pode ser reconciliado com o ledger.
- Uma falha antes do commit não deixa efeitos financeiros ou eventos visíveis.
- Há mais escritas por operação, em troca de rastreabilidade e consistência verificável no banco.

## Referências

- `src/modules/wallets/open-wallet.service.ts`
- `src/modules/wagering/process-wager-transaction.service.ts`
- `src/infrastructure/database/migrations/Migration20261021220000.ts`
- `src/infrastructure/database/migrations/Migration20261022200000.ts`
