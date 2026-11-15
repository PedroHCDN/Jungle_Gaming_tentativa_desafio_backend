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

Travo a wallet antes de registrar a transação. O plano lista o INSERT primeiro. Fiz o contrário por dois motivos: uma wallet inexistente é detectada sem violar a FK, e a ordem “wallet primeiro” fica igual em todos os caminhos. O custo é que um replay também espera o lock por um instante.

Mesmo external id com outra chave e mesmo payload é replay, não conflito, porque é o mesmo fato de negócio.

walletBalance no resultado é o saldo atual da wallet, lido com ela travada. No replay de uma BET antiga, é o saldo de agora, não o da época.

Player que não é dono da wallet lança PlayerWalletMismatchError e não persiste nada. Não existe failureCode para isso.

Os outros kinds (WIN, LOSS, REFUND, ROLLBACK) lançam UnsupportedWagerKindError por enquanto. Os eventos já existem; o WalletBalanceChanged só é emitido quando o saldo muda.

LOSS não gera lançamento nem WalletBalanceChanged, mas gera WagerTransactionProcessed.
WIN não precisa ter o mesmo valor do BET referenciado. Só REFUND e ROLLBACK exigem valor igual.

-- Um caso de uso, uma transação
ProcessWagerTransactionUseCase atende HTTP e SQS e processa BET, WIN, LOSS, REFUND e ROLLBACK em uma única transação SQL. A ordem é:

Travar a wallet.
Registrar a mensagem na inbox, quando vem do SQS.
Registrar a transação com INSERT … ON CONFLICT DO NOTHING.
Avaliar as regras.
Gravar ledger, saldo e status.
Gravar os eventos na outbox.

Qualquer falha desfaz tudo. A publicação da outbox é posterior ao commit --

-- Estratégia de lock

Lock pessimista por walletId, sem lock global.
É FOR NO KEY UPDATE, não FOR UPDATE. O FOR UPDATE conflita com o FOR KEY SHARE que o INSERT de uma transação filha toma pela FK, e o teste de concorrência provocou um deadlock real (40P01).
A wallet é travada antes do INSERT. Uma wallet inexistente é detectada sem violar a FK, e a ordem “wallet primeiro” é a mesma em todos os caminhos.
Versão otimista e trigger de version + 1 são a segunda linha de defesa.
Alternativa descartada: update atômico condicionado. É mais simples de ler, mas deixaria a regra de negócio espalhada no SQL.
A ordem do ledger e da outbox depende de seq, que só é confiável com o lock-first. --

-- Idempotência

A chave é única por provider, não global.
O payloadHash é SHA-256 sobre JSON canônico (chaves ordenadas), só com campos de negócio. O idempotencyKey e os metadados de transporte ficam de fora.
Mesmo hash devolve o resultado original com idempotentReplay: true. Hash diferente devolve IdempotencyConflictError, que vira 409 na API (decisão sua).
O mesmo external id com outra chave e o mesmo payload é o mesmo fato de negócio, então é replay. --

-- Inbox (SQS)

A deduplicação por (consumerName, messageId) fica na mesma transação do efeito.
payload_hash detecta o mesmo messageId com conteúdo diferente.
Erros permanentes (conflito de idempotência e de payload) devem ir para a DLQ. --

-- Resolução da referência

A busca é por (providerId, referenceExternalTransactionId).
Checagens: provider, player, wallet, moeda, rodada, tipo e, nas reversões, valor igual (sem reversão parcial).
A referência precisa estar PROCESSED. REJECTED ou FAILED vira REFERENCE_NOT_PROCESSED. --

-- Regras por kind

BET debita. WIN e REFUND creditam. ROLLBACK inverte o sentido da referência.
WIN e LOSS têm referência opcional a um BET, e o valor do WIN não precisa ser igual ao do BET.
LOSS não gera lançamento nem WalletBalanceChanged, mas gera WagerTransactionProcessed.
Só uma reversão por referência (REFUND ou ROLLBACK), com ALREADY_REVERSED e um índice único parcial no banco. Isso é mais estrito que o “mesmo tipo” do README.
Reversão que deixaria o saldo negativo vira REVERSAL_WOULD_OVERDRAW, distinto de INSUFFICIENT_FUNDS. --

-- Referência ausente (PENDING_REFERENCE)

A transação fica pendente com nextAttemptAt e emite WagerTransactionPendingReference uma vez.
Política: 5 buscas com backoff exponencial a partir de 1 s (esperas de 1, 2, 4 e 8 s). Na 5ª falha vira REJECTED com REFERENCE_NOT_FOUND.
retryPendingReference(transactionId) é o ponto de entrada do worker. Ele é idempotente e ignora o que não venceu ou já foi resolvido.
O reprocessamento usa o mesmo evaluate da chegada nova, então as regras não divergem.
Cadeias funcionam: um ROLLBACK de um REFUND pendente espera pelo REFUND. --

-- Eventos (outbox)

WagerTransactionProcessed, WagerTransactionRejected, WagerTransactionPendingReference e WalletBalanceChanged.
O agregado é a wallet, e o envelope é versionado.
Dinheiro viaja como string decimal. --

-- Estratégia de testes
Todos rodam contra PostgreSQL real, sem mock de banco. O relógio é injetável, então o backoff é testado sem esperar. Os principais testes:

O cenário obrigatório: 100,00 e duas apostas de 80,00 simultâneas dão uma PROCESSED, uma REJECTED, saldo 20,00 e um único débito no ledger.
30 envios simultâneos da mesma aposta dão um débito.
15 REFUNDs simultâneos da mesma aposta dão um crédito.
60 operações misturadas e embaralhadas mantêm saldo igual ao ledger.
Atomicidade: se a outbox falha, tudo é desfeito.

Mutações aplicadas: remover o lock, a checagem de payload, a de reversão já aplicada, o backoff exponencial, o esgotamento e a releitura sob lock fazem testes quebrar. --

-- Limitações conhecidas

A janela de 15 s é curta para produção. A política é injetável.
Sem jitter, então muitos pendentes alinham os retries.
O retry é por polling (Fase 5): quem espera uma referência não é acordado quando ela chega.
Erros inesperados de overflow de saldo propagam como exceção. --
