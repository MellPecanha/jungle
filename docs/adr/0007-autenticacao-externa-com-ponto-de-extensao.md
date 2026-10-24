# ADR 0007 — Adiar autenticação e manter um ponto de extensão OIDC

- Status: Aceita
- Data: 2026-10-23

## Contexto

O desafio explicitamente não pontua a implementação de autenticação, mas requer que a decisão seja documentada e proíbe autenticação artesanal baseada em tabela própria de usuários. Health checks devem permanecer públicos.

## Decisão

Não integrar um IdP no timebox. Os endpoints de negócio usam `ProviderIdentityGuard` no-op como ponto de extensão. Em produção, ele será substituído por um guard NestJS que valida tokens emitidos por um IdP OIDC (por exemplo, Keycloak ou Zitadel) e autoriza o provedor. Mensagens SQS são tratadas como canal interno confiável: a implementação atual valida seu envelope e regras de domínio, mas ainda não autentica nem autoriza a identidade do provedor.

## Consequências

- O domínio financeiro não depende de um fornecedor de identidade.
- A aplicação atual não deve ser exposta como API pública sem configurar o guard real.
- A autorização do `providerId` presente em mensagens internas também é uma extensão futura.
- `/health/live` e `/health/ready` continuam sem autenticação.

## Referências

- `src/common/auth/provider-identity.guard.ts`
- `src/modules/health/health.controller.ts`
