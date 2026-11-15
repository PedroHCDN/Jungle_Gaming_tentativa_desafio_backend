ContentBasedDeduplication: "false": o broker não deduplica por conteúdo, então os testes de redelivery exercitam de verdade a inbox. Quem envia mensagens (inclusive seus testes) deve passar MessageDeduplicationId e MessageGroupId, e a walletId é uma boa escolha de grupo para manter a ordem por wallet.

maxReceiveCount: 5: o redrive para a DLQ é feito pelo próprio SQS, e o consumer ainda precisa classificar erros de negócio, transitórios e permanentes.

Money guarda centavos em bigint, e não em decimal.js. Nenhum valor passa por number ou float, a aritmética é exata e o domínio não depende de biblioteca. Você pode remover o decimal.js do package.json, a menos que queira usá-lo em outro lugar.

-- Parser estrito em Money.from:

Rejeita number, bigint, null, NaN, Infinity, notação científica, sinal, vírgula, separador de milhar, zeros à esquerda e mais de 2 decimais.
Aceita "25", "25.5" e "25.50" e normaliza para "25.00". Se preferir exigir sempre 2 casas na entrada, troque {1,2} por {2} no regex.

Limita o valor a numeric(19,2) e lança MoneyOverflowError acima disso, para o domínio nunca produzir um número que o banco não aceita. --

Guarda contra falha eliminatória: um teste lê o código-fonte do Money e falha se aparecer number, parseFloat, parseInt, Number(, Math. ou Decimal.

-- Wallet:

debit e credit devolvem um BalanceMovement (direção, valor, saldo antes e depois, versão). A Fase 3 vai construir o WalletLedgerEntry a partir dele, então saldo e ledger saem do mesmo dado.

A version só incrementa quando o saldo muda. Uma operação rejeitada deixa a wallet intacta.

O relógio entra por parâmetro (at, now), o que mantém o domínio puro e os testes determinísticos.

Wallet.open já começa com o saldo inicial e version = 1. A transação OPENING e o lançamento CREDIT com balanceBefore = 0 serão gravados pelo caso de uso, na mesma transação SQL.

debit lança sempre InsufficientFundsError. Quem escolhe entre INSUFFICIENT_FUNDS (aposta) e REVERSAL_WOULD_OVERDRAW (reversão) é o caso de uso, conforme o kind. --

Com bundler, a saída do nest build tem imports sem extensão e não roda direto no Node puro. Isso não afeta o projeto, porque a aplicação roda com bun src/main.ts (o Dockerfile já faz isso), mas evite node dist/main.js.

A alternativa é manter nodenext e escrever .js em todos os imports relativos (from './money.js'). Funciona, mas polui o código sem ganho.

-- Máquina de estados

PENDING pode ir para qualquer outro status. PENDING_REFERENCE vai para PROCESSED, REJECTED ou FAILED, e também para ela mesma, porque o worker reprocessa e a referência pode continuar ausente.

PROCESSED, REJECTED e FAILED são terminais: qualquer transição lança InvalidTransactionStateError, e o estado fica intacto. O teste percorre as 25 combinações.

reject() só aceita códigos de negócio e fail() só aceita o código de infraestrutura, para o status nunca contradizer o código. --

-- payloadHash

SHA-256 em hex sobre o JSON canônico (chaves ordenadas em todos os níveis, sem espaços, undefined omitido) dos campos de negócio.

O header Idempotency-Key, o instante de criação e os metadados de transporte ficam de fora.

O valor passa por Money, então "25" e "25.00" geram o mesmo hash.

O create calcula o hash sozinho, então não há como ele ficar inconsistente com os campos. --

-- Regras de criação

OPENING é rejeitado em create, e existe createOpening separado para o POST /wallets.

REFUND e ROLLBACK exigem referência, BET não pode ter, e WIN e LOSS têm referência opcional.

Valor zero só é aceito em LOSS, e isso é uma interpretação minha: um WIN de zero iria contra a regra da wallet de só movimentar valores positivos. --

-- failureCodes e quando ocorrem

INSUFFICIENT_FUNDS: BET sem saldo.
REVERSAL_WOULD_OVERDRAW: REFUND/ROLLBACK deixaria saldo negativo.
REFERENCE_NOT_FOUND: referência não chegou dentro do limite.
REFERENCE_MISMATCH: referência de outro provider, player, wallet, moeda ou rodada.
INVALID_REFERENCE_KIND: REFUND que não aponta para BET, ou ROLLBACK fora de BET/WIN/REFUND.
AMOUNT_MISMATCH: valor da reversão diferente do original.
ALREADY_REVERSED: referência já revertida pelo mesmo tipo.
CURRENCY_MISMATCH: moeda da operação diferente da wallet.
REFERENCE_NOT_PROCESSED: a referência existe, mas foi rejeitada ou falhou, então não há o que reverter.
PERMANENT_INFRASTRUCTURE_ERROR: erro permanente de infraestrutura (transação FAILED, nunca REJECTED). --

checkReference devolve o FailureCode da primeira violação: REFERENCE_MISMATCH (provider, player, wallet, rodada ou moeda), depois INVALID_REFERENCE_KIND e por fim AMOUNT_MISMATCH. Ele não olha o status da referência nem se ela já foi revertida, porque isso depende de estado persistido.

---

Saldo nunca negativo: CHECK em wallets.
Ledger imutável: triggers de UPDATE, DELETE e TRUNCATE.
Saldo da wallet igual ao último balance_after do ledger: trigger deferida, conferida no COMMIT.
Transação PROCESSED que move saldo tem seu lançamento no ledger.
Reversão só aponta para uma transação PROCESSED, do tipo certo, do mesmo valor e da mesma wallet.
Chave de idempotência única por provider.
Transição de status ilegal bloqueada por trigger.

dono e superusuário do banco contornam triggers. Em produção, o usuário da aplicação precisa de REVOKE UPDATE, DELETE, TRUNCATE.

A regra lock-first: todo escritor trava a wallet antes de ler o saldo.
Por que FOR NO KEY UPDATE e não FOR UPDATE. Vale contar o deadlock real (40P01) que o teste de concorrência pegou, porque mostra que as decisões foram validadas.
A versão otimista é a segunda linha de defesa, e o trigger exige version = old + 1.
A ordem do ledger e do outbox depende de seq, e seq só é confiável com o lock-first.
A ordem das operações dentro do caso de uso: inserir a transação, travar a wallet, debitar, gravar ledger e saldo, concluir.

A chave é única por provider, não global.
INSERT … ON CONFLICT DO NOTHING e comparação do payloadHash.
O que o payloadHash cobre e o que fica de fora (o header de idempotência não entra).
O comportamento para mesma chave com payload diferente.

bigint em unidades menores, contrato com string decimal, numeric(19,2) no banco.
Entradas com mais de 2 casas decimais são rejeitadas em Money.from, porque o numeric(19,2) arredondaria em silêncio.
O row-parsers recusa qualquer numeric que chegue como number.

Uma transação só pode ser revertida uma vez, por REFUND ou por ROLLBACK. O README fala em “mesmo tipo”.
Taxonomia: REJECTED (regra de negócio) contra FAILED (infraestrutura).

Migrations escritas à mão em SQL (--blank, nunca o diff), constraints e triggers que o MikroORM não gera. O registro é por migrationsList.
Repositories em SQL via em.execute, sem entities. Motivos: seq é GENERATED ALWAYS, há triggers deferidos, ON CONFLICT e SKIP LOCKED, e um unit-of-work reordenaria os writes.
TransactionRunner e DbSession como fronteira de transação, definida pelo caso de uso.

Os testes de concorrência: 25 apostas em saldo de 10, e a mesma aposta 10 vezes em paralelo.
