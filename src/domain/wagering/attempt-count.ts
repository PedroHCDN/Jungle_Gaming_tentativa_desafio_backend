/**
 * Contador de tentativas (inteiro >= 0). Não é dinheiro: tem tipo próprio para
 * o guard de `wager-transaction.ts` continuar proibindo `number` em valores.
 */
export type AttemptCount = number;
