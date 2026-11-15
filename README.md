# Distributed Wagering Processor

Serviço financeiro distribuído que processa transações de apostas
(`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) recebidas de múltiplos provedores,
mantendo saldo e ledger consistentes sob duplicidade, desordem e concorrência.

Desafio técnico da Jungle Gaming. Stack: Bun, TypeScript (strict), NestJS,
MikroORM, PostgreSQL e AWS SQS (LocalStack).

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
bun run start:dev         # aplicação em modo watch
```

O `.env` não deve ser commitado (já está no `.gitignore`).
Para.env.example: copie .env.example para .env e preencha

## Comandos

| Comando                                                        | O que faz                                        |
| -------------------------------------------------------------- | ------------------------------------------------ |
| `bun run start:dev`                                            | Sobe a aplicação em modo watch                   |
| `bun run build`                                                | Compila o projeto                                |
| `bun test`                                                     | Roda os testes                                   |
| `bun run lint`                                                 | Roda o ESLint                                    |
| `bunx tsc --noEmit`                                            | Checa os tipos                                   |
| `bun run infra:up`                                             | Sobe PostgreSQL e LocalStack e cria as filas SQS |
| `bun run infra:down`                                           | Derruba os containers                            |
| `bun run infra:reset`                                          | Derruba os containers e apaga os volumes         |
| `bun run queues:create`                                        | Recria as filas (idempotente)                    |
| `bun run migration:create` / `migration:up` / `migration:down` | Migrations                                       |

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
  domain/           regras e invariantes (sem NestJS nem ORM)
  application/      casos de uso
  infrastructure/   persistência, SQS, outbox
  interfaces/       HTTP e consumers
scripts/            utilitários (criação das filas)
```

## Status

- [x] Fase 0: fundação (projeto, Docker Compose, filas, lint, CI)
- [x] Fase 1: domínio (`Money`, `Wallet`, `WagerTransaction`, ledger)
- [x] Fase 2: schema e migrations
- [x] Fase 3: use case e concorrência
- [ ] Fase 4: API HTTP
- [ ] Fase 5: SQS, outbox e workers
- [ ] Fase 6: testes de integração e concorrência
- [ ] Fase 7: observabilidade

## API

_A preencher na Fase 4._

## Decisões de arquitetura

Veja [ARCHITECTURE.md](./ARCHITECTURE.md).
