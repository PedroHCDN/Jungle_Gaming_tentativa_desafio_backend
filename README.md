# Distributed Wagering Processor

Serviço financeiro distribuído que processa transações de apostas
(`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) recebidas de vários provedores de jogos
e mantém **saldo e ledger corretos** mesmo quando as mensagens chegam
**duplicadas, fora de ordem ou ao mesmo tempo**.

Desafio técnico da Jungle Gaming: https://github.com/junglegaming/backend-challenge.git. Stack: Bun, TypeScript (strict), NestJS,
MikroORM, PostgreSQL e AWS SQS (LocalStack).

## O que o projeto resolve

Provedores de jogos enviam as operações de uma rodada com entrega *at-least-once*:
a mesma mensagem pode chegar duas vezes, um `ROLLBACK` pode chegar antes da aposta
que ele reverte, e duas apostas da mesma carteira podem chegar no mesmo instante.
O serviço precisa garantir, sempre:

- **nenhum crédito ou débito duplicado** (idempotência);
- **nenhum saldo negativo**, nem sob concorrência;
- **nenhum evento confirmado perdido** (outbox transacional);
- **saldo da carteira = saldo reconstruído pelo ledger**, que é imutável.

Essas garantias valem **no banco de dados** (constraints, índices únicos e triggers),
e não só no código da aplicação.

## Como funciona, em resumo

Um único caso de uso (`ProcessWagerTransactionUseCase`) atende HTTP e SQS. Para cada
transação, dentro de **uma só transação SQL**, ele:

1. trava a carteira (`SELECT … FOR NO KEY UPDATE`);
2. registra a mensagem na inbox, se ela veio do SQS;
3. registra a transação de forma idempotente (`INSERT … ON CONFLICT DO NOTHING`);
4. aplica a regra do tipo da operação;
5. grava o lançamento no ledger, o novo saldo e o status;
6. grava os eventos na outbox.

Se qualquer passo falha, nada é persistido. Os eventos só serão publicados depois do commit.

### Regras de negócio

| Operação   | Efeito                                                                                          |
| ---------- | ----------------------------------------------------------------------------------------------- |
| `BET`      | Debita. Sem saldo, a transação é `REJECTED` com `INSUFFICIENT_FUNDS`.                           |
| `WIN`      | Credita. Pode referenciar uma `BET`, mas o valor não precisa ser igual ao dela.                 |
| `LOSS`     | Não move saldo e não gera lançamento no ledger. Aceita valor `0.00`.                            |
| `REFUND`   | Reverte uma `BET` (credita).                                                                    |
| `ROLLBACK` | Reverte uma `BET`, um `WIN` ou um `REFUND` (inverte o efeito da referência).                    |

Reversões (`REFUND` e `ROLLBACK`) exigem uma referência do mesmo provider, player, carteira,
moeda e rodada, com **valor igual** (não há reversão parcial), e cada referência só pode ser
revertida **uma vez**. Se a referência ainda não chegou, a transação fica em
`PENDING_REFERENCE` e é reprocessada com backoff exponencial; esgotadas as tentativas, é rejeitada
com `REFERENCE_NOT_FOUND`.

Uma reversão que deixaria o saldo negativo é rejeitada com `REVERSAL_WOULD_OVERDRAW`, um código
diferente do de aposta sem saldo.

Dinheiro nunca passa por `number` ou `float`: o contrato usa string decimal com 2 casas
(`{ "amount": "25.00", "currency": "BRL" }`) e o domínio calcula em `bigint`.

Os detalhes técnicos e as decisões de arquitetura estão em [ARCHITECTURE.md](./ARCHITECTURE.md).

## Requisitos

- [Bun](https://bun.sh) 1.x
- Docker Desktop (no Windows, com o backend WSL2 ligado)
- Conta gratuita no [LocalStack](https://localstack.cloud) para obter o
  `LOCALSTACK_AUTH_TOKEN`, que a imagem atual exige

## Primeiros passos

```bash
bun install
cp .env.example .env      # PowerShell: Copy-Item .env.example .env
# edite o .env e preencha LOCALSTACK_AUTH_TOKEN
bun run infra:up          # sobe PostgreSQL + LocalStack e cria as filas
bun run db:migrate        # aplica o schema no PostgreSQL
bun run start:dev         # aplicação em modo watch
```

O `.env` não deve ser commitado (já está no `.gitignore`). O token do LocalStack fica
**somente** no `.env`; o `docker-compose.yml` apenas o referencia.

> Na Fase 3 ainda não há endpoints HTTP nem consumer SQS: a lógica de negócio é exercitada
> pelos testes. A API entra na Fase 4.

## Comandos

| Comando                                                        | O que faz                                                      |
| -------------------------------------------------------------- | -------------------------------------------------------------- |
| `bun run start:dev`                                            | Sobe a aplicação em modo watch                                 |
| `bun run build`                                                | Compila o projeto                                              |
| `bun run test`                                                 | Testes unitários (`bun test src`), sem banco                   |
| `bun run test:int`                                             | Testes de integração, contra o PostgreSQL real (exige `infra:up`) |
| `bun run lint`                                                 | Roda o ESLint                                                  |
| `bunx tsc --noEmit`                                            | Checa os tipos                                                 |
| `bun run db:migrate`                                           | Aplica as migrations                                           |
| `bun run migration:create` / `migration:up` / `migration:down` | Migrations (CLI do MikroORM)                                   |
| `bun run infra:up`                                             | Sobe PostgreSQL e LocalStack e cria as filas SQS               |
| `bun run infra:down`                                           | Derruba os containers                                          |
| `bun run infra:reset`                                          | Derruba os containers e apaga os volumes                       |
| `bun run queues:create`                                        | Recria as filas (idempotente)                                  |

## Testes

- **Unitários** (`src/**/*.spec.ts`): domínio puro (`Money`, `Wallet`, máquina de estados da
  `WagerTransaction`, ledger, hash do payload), sem banco.
- **Integração** (`test/integration/*.int.spec.ts`): rodam contra **PostgreSQL real**, sem mock de
  banco. Cada suíte cria um banco novo e isolado, aplica o schema e o apaga no fim. Por isso o usuário
  da conexão precisa poder criar bancos (o do `docker compose` pode). A conexão vem de `DATABASE_URL`
  (padrão: o PostgreSQL local do Compose).
- Os testes de concorrência usam paralelismo real, incluindo o cenário obrigatório do desafio:
  saldo de 100,00 e duas apostas simultâneas de 80,00 resultam em uma `PROCESSED`, uma `REJECTED`,
  saldo de 20,00 e um único débito no ledger.
- Todo teste de escrita termina conferindo que **o saldo da carteira é igual ao ledger**.

## Infraestrutura local

| Serviço          | Endereço                | Observação                                      |
| ---------------- | ----------------------- | ----------------------------------------------- |
| PostgreSQL 16    | `localhost:5432`        | usuário, senha e banco: `wagering`              |
| LocalStack (SQS) | `http://localhost:4566` | credenciais `test` / `test`, região `us-east-1` |

Filas criadas por `scripts/create-queues.ts`:

- `wager-transactions.fifo`: fila principal, com redrive para a DLQ após 5 recebimentos
- `wager-transactions-dlq.fifo`: dead-letter queue

As filas são FIFO com `ContentBasedDeduplication` desligado: quem publica deve
informar `MessageDeduplicationId` e `MessageGroupId` (a `walletId` é o grupo).
A deduplicação que importa é a da inbox no banco, não a do broker.

Para subir várias instâncias da aplicação (necessário nos testes de concorrência):

```bash
docker compose --profile app up -d --build --scale app=3
```

## Estrutura do projeto

```
src/
  domain/            regras e invariantes (sem NestJS nem ORM): Money, Wallet,
                     WagerTransaction, WalletLedgerEntry, FailureCode, erros
  application/       caso de uso, portas (interfaces), eventos e erros de aplicação
  infrastructure/    persistência (schema SQL, migrations, repositórios) e relógio/ids
  interfaces/        HTTP e consumers (Fases 4 e 5)
test/integration/    testes contra PostgreSQL real
scripts/             utilitários (criação das filas)
```

## Status

- [x] Fase 0: fundação (projeto, Docker Compose, filas, lint, CI)
- [x] Fase 1: domínio (`Money`, `Wallet`, `WagerTransaction`, ledger)
- [x] Fase 2: schema e migrations
- [x] Fase 3: use case e concorrência (BET, WIN, LOSS, REFUND, ROLLBACK, idempotência, referência
      fora de ordem, inbox e outbox)
- [ ] Fase 4: API HTTP
- [ ] Fase 5: SQS (consumer), publisher da outbox e workers
- [ ] Fase 6: testes de integração e concorrência com SQS e várias instâncias
- [ ] Fase 7: observabilidade

## API

_A preencher na Fase 4._ Endpoints previstos:

| Método e caminho                                                       | Objetivo                                         |
| ---------------------------------------------------------------------- | ------------------------------------------------ |
| `POST /wallets`                                                        | Cria a carteira (saldo inicial vira `OPENING`)   |
| `GET /wallets/:walletId`                                               | Consulta a carteira                              |
| `GET /wallets/:walletId/ledger?cursor=&limit=`                         | Lista o ledger com cursor opaco                  |
| `POST /wagering/transactions`                                          | Envia uma transação (header `Idempotency-Key`)   |
| `GET /wagering/transactions/:transactionId`                            | Consulta por id interno                          |
| `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | Consulta pelo id do provedor                  |
| `POST /wallets/:walletId/reconciliation`                               | Compara o saldo armazenado com o do ledger       |
| `GET /health/live` e `GET /health/ready`                               | Liveness e readiness                             |

## Decisões de arquitetura

Veja [ARCHITECTURE.md](./ARCHITECTURE.md).
