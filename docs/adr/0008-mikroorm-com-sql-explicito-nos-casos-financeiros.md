# ADR 0008 — Usar MikroORM para infraestrutura e SQL explícito nos casos financeiros

- Status: Aceita
- Data: 2026-10-23

## Contexto

O desafio pede MikroORM preferencialmente, migrations versionadas e uma estratégia transacional justificável. Os caminhos críticos precisam expressar locks PostgreSQL, índices parciais e constraints financeiras sem que esses detalhes fiquem implícitos no ORM.

## Decisão

Usar MikroORM para ciclo de vida da conexão, migrations e `EntityManager.transactional()`. Nos casos de uso financeiros, executar SQL parametrizado via `EntityManager`, inclusive `FOR NO KEY UPDATE` e `FOR UPDATE SKIP LOCKED`, em vez de introduzir repositórios genéricos ou depender de mapeamento automático para a coordenação.

As entidades de domínio permanecem livres de decorators do NestJS, do ORM e de tipos de persistência; são reidratadas a partir das linhas bloqueadas dentro da transação.

## Consequências

- Locks, constraints e limites de transação ficam visíveis no código que coordena dinheiro.
- O domínio segue testável sem PostgreSQL, enquanto as garantias de integração dependem de PostgreSQL real.
- Os casos de uso ficam deliberadamente acoplados ao dialeto PostgreSQL e ao `EntityManager`, um trade-off aceito para este serviço financeiro.

## Referências

- `src/infrastructure/database/mikro-orm.config.ts`
- `src/modules/wallets/open-wallet.service.ts`
- `src/modules/wagering/process-wager-transaction.service.ts`
