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

