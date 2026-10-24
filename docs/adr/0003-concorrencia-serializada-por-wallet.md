# ADR 0003 — Serializar operações financeiras por wallet com lock de linha

- Status: Aceita
- Data: 2026-10-23

## Contexto

Várias instâncias podem processar mensagens simultâneas. Duas apostas concorrentes não podem consumir o mesmo saldo, mas wallets distintas não devem ser bloqueadas por um lock global.

## Decisão

Dentro da transação financeira, carregar a wallet por `SELECT ... FOR NO KEY UPDATE`. A wallet é a unidade de concorrência. Após obter o lock, o caso de uso reidrata o agregado, aplica débito ou crédito, incrementa sua versão e persiste o resultado.

Workers que retomam referências seguem a mesma ordem de lock: wallet antes da transação pendente. Os workers de outbox usam `FOR UPDATE SKIP LOCKED` para distribuir linhas entre publishers concorrentes.

## Consequências

- Operações da mesma wallet são serializadas e não sofrem lost update; wallets diferentes continuam paralelas.
- A contenção de uma hot wallet aumenta a latência apenas daquela wallet.
- Deadlocks e falhas de serialização continuam possíveis em sistemas distribuídos; são classificados como transitórios, medidos e expostos como `503` no caminho HTTP, sem retry imediato ilimitado.

## Referências

- `src/modules/wagering/process-wager-transaction.service.ts`
- `src/modules/wagering/wager-worker.service.ts`
- `src/infrastructure/messaging/outbox-publisher.service.ts`
