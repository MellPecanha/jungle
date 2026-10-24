# ADR 0001 — Representar dinheiro com Decimal e `numeric(20,2)`

- Status: Aceita
- Data: 2026-10-23

## Contexto

O processador move saldo real e o desafio proíbe `number`, `float` e `double` para dinheiro. Os contratos HTTP e de eventos exigem valores decimais com duas casas e moeda ISO-4217.

## Decisão

Usar o value object imutável `Money`, baseado em `Decimal`, no domínio. A API recebe e devolve `{ amount: string, currency: string }`; `amount` deve ter escala fixa de duas casas, e operações entre moedas distintas falham no domínio.

Persistir valores nas colunas PostgreSQL `numeric(20,2)` e moeda separadamente em `varchar(3)`. O banco também rejeita valores não positivos onde uma movimentação exige valor positivo.

A implementação valida o formato da moeda como três letras maiúsculas; não consulta um catálogo completo de ISO-4217.

## Consequências

- Não há arredondamento binário nem conversão de saldo para `number`.
- A moeda continua parte do modelo, embora o ambiente de desafio opere tipicamente em BRL.
- Adaptadores de HTTP, SQL e eventos precisam preservar `amount` como string.

## Referências

- `src/common/money/money.ts`
- `src/infrastructure/database/migrations/Migration20261021220000.ts`
