# Arquitetura

## Boundaries

O código está organizado em `src/modules` por responsabilidade; `src/infrastructure` reúne banco e mensageria, e `src/common` contém recursos compartilhados. As classes de domínio não importam NestJS, MikroORM ou SQS. Os serviços NestJS acessam PostgreSQL diretamente por SQL através do `EntityManager`, sem uma camada de repositórios ou portas de persistência. A escolha torna locks e constraints explícitos, mas acopla os casos de uso ao PostgreSQL e ao MikroORM.

`Money`, `Wallet`, `WagerTransaction` e `WalletLedgerEntry` possuem factories e regras de domínio. Na abertura, o serviço utiliza `Wallet.open`. No processamento, reidrata a wallet bloqueada, aplica `debit` ou `credit` e persiste o saldo e a versão resultantes; as transições da transação são aplicadas ao modelo antes da persistência. A inbox usa `InboxMessage` para registrar seu processamento e o publisher reidrata `OutboxMessage` para publicação e retry. A coordenação e a persistência ainda usam SQL direto, e regras de referência permanecem no serviço de processamento.

## Dinheiro

Entradas monetárias são strings com escala fixa de duas casas. `Decimal` evita erro binário de ponto flutuante. O PostgreSQL usa `numeric(20,2)`, nunca `double` ou `number` para valores financeiros. A moeda é validada como três letras maiúsculas; não há consulta a uma lista completa de códigos ISO-4217.

## Persistência e atomicidade

MikroORM é usado para conexão, migrations e `EntityManager.transactional()`. A criação de wallet grava wallet, `OPENING`, ledger e evento de outbox na mesma transação. Falha em qualquer etapa causa rollback.

## Concorrência

A unidade de concorrência é `wallet_id`. O processamento financeiro usa lock de linha PostgreSQL (`SELECT ... FOR NO KEY UPDATE`) dentro da transação. Assim, duas operações da mesma wallet são serializadas, enquanto wallets diferentes continuam paralelas. A unicidade de idempotência é reforçada pelo banco.

## Idempotência

`idempotency_key` é globalmente única e `provider_id + external_transaction_id` também é único. A migration da chave global exige que não existam chaves repetidas entre provedores no banco existente. O `payload_hash` usa SHA-256 de um JSON com as chaves dos campos de negócio em ordem alfabética e `money` serializado como `amount`, `currency`. Replays também aceitam o hash da ordenação anterior para preservar operações já persistidas. O saldo retornado no replay é persistido com a transação. Como a migration não reconstrói saldos antigos, replays de registros anteriores podem não incluir saldo. Mesmo payload retorna replay; mesma chave com hash diferente é conflito.

## Inbox e Outbox

Inbox deduplica mensagens por `(consumer_name, messageId do envelope)` e é gravada na mesma transação da operação financeira. O ack ocorre após o commit. A outbox é gravada no mesmo commit e publicada na fila `wager-events.fifo`, com seleção concorrente via `FOR UPDATE SKIP LOCKED`. O transporte pode duplicar eventos após falha entre publicação e commit; consumidores devem deduplicar pelo `eventId`.

## Mensageria

LocalStack fornece SQS FIFO e DLQ. FIFO reduz duplicatas acidentais e preserva agrupamento, mas não é garantia de consistência: as constraints e transações do PostgreSQL continuam sendo a fonte de verdade. No encerramento, o worker aguarda suas tarefas em andamento; a leitura da fila usa long polling e o processamento não renova a visibilidade durante operações longas. Se o prazo de visibilidade expirar, a inbox e a idempotência continuam necessárias para uma eventual redelivery.

## Autenticação

Fora do escopo do timebox, pois não pontua. Em produção seria usado um IdP OIDC, com um guard NestJS validando identidade e provider autorizado. O `ProviderIdentityGuard` no-op é o ponto de extensão explícito nos endpoints de negócio e não faz autenticação. Health permanece público. O domínio permanece independente dessa decisão.

## Limitações conscientes

OpenTelemetry e teste de carga são opcionais e ficam fora da primeira entrega. O endpoint `/metrics` expõe contagens de transações por status, atraso da outbox, profundidade aproximada da DLQ e contadores locais por processo de duplicatas, retries, envios à DLQ, conflitos de lock e tempo de processamento. Contadores locais reiniciam com o processo e precisam ser coletados por instância; redrive automático do SQS não incrementa o contador de envios diretos à DLQ. Logs usam JSON e não incluem valores financeiros completos. WIN com referência exige uma BET processada da mesma rodada e wallet, sem exigir valores iguais. Referências ausentes ou não terminais são reavaliadas com backoff exponencial limitado a 300 segundos; após oito tentativas são rejeitadas com `REFERENCE_NOT_FOUND`. Mensagens inválidas e conflitos são encaminhados diretamente à DLQ antes do ack; falhas transitórias recebem backoff e são movidas pela política de redrive da fila. A suíte de integração cobre redelivery, saída de processo após commit, DLQ, dois publishers e disputa de saldo entre três processos. A entrega à DLQ pode ser repetida após falha entre envio e ack. A migration de saldo de replay não reconstrói resultados de transações já existentes.

O publisher mantém a transação e o lock da linha da outbox abertos durante a chamada ao SQS; lentidão do broker aumenta o tempo de retenção da conexão e do lock. O worker de referências bloqueia primeiro a wallet e depois a transação pendente, seguindo a ordem do processamento financeiro; wallets bloqueadas são ignoradas até outra execução do worker. Isso reduz o risco de deadlock entre esses caminhos, mas não elimina todas as possibilidades. O PostgreSQL detecta deadlocks e o HTTP os trata como falhas transitórias; não há retry imediato limitado no caso de uso HTTP.

## HTTP e paginação

A API responde 400 para payload inválido, 404 para wallet ou transação inexistente, 409 para conflito de identidade, 422 para rejeição de negócio, 202 para referência pendente e 503 para códigos conhecidos de falha transitória de infraestrutura. O cursor do ledger preserva a precisão de microssegundos do PostgreSQL. `dlqDepth` é uma estimativa do SQS; se o SQS estiver indisponível, o valor é `null`.

## Estados e falhas

A criação inicia em `PENDING`; referências ausentes passam a `PENDING_REFERENCE`. `PROCESSED`, `REJECTED` e `FAILED` são terminais. Códigos atuais: `INSUFFICIENT_FUNDS`, `REVERSAL_INSUFFICIENT_FUNDS`, `REFERENCE_NOT_FOUND`, `INVALID_REFERENCE`, `DUPLICATE_REVERSAL`, `INVALID_PAYLOAD` e `INTERNAL_ERROR`.
