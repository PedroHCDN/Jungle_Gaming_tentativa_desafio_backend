/**
 * Taxonomia de falhas: códigos estáveis e legíveis por máquina.
 * Servem para o provedor decidir se reenvia, corrige o payload ou desiste.
 */
export enum FailureCode {
  // ---- REJECTED (regra de negócio) ----
  /** BET sem saldo. O provedor não deve reenviar. */
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  /** REFUND/ROLLBACK deixaria o saldo negativo. Situação distinta de BET sem saldo: investigar. */
  ReversalWouldOverdraw = 'REVERSAL_WOULD_OVERDRAW',
  /** A referência não chegou dentro do limite de tentativas/TTL. Reenviar a referência. */
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  /** A referência existe, mas foi REJECTED/FAILED, então não há o que reverter. */
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  /** A referência é de outro provider, player, wallet, moeda ou rodada. Corrigir o payload. */
  ReferenceMismatch = 'REFERENCE_MISMATCH',
  /** REFUND que não aponta para BET, ou ROLLBACK fora de BET/WIN/REFUND. Corrigir o payload. */
  InvalidReferenceKind = 'INVALID_REFERENCE_KIND',
  /** Valor da reversão diferente do valor da referência (reversão parcial fora de escopo). */
  AmountMismatch = 'AMOUNT_MISMATCH',
  /** A referência já foi revertida (por REFUND ou ROLLBACK: só uma reversão por referência). Não reenviar. */
  AlreadyReversed = 'ALREADY_REVERSED',
  /** Moeda da operação diferente da moeda da wallet. Corrigir o payload. */
  CurrencyMismatch = 'CURRENCY_MISMATCH',

  // ---- FAILED (infraestrutura, permanente) ----
  PermanentInfrastructureError = 'PERMANENT_INFRASTRUCTURE_ERROR',
}

const INFRASTRUCTURE_CODES: ReadonlySet<FailureCode> = new Set([
  FailureCode.PermanentInfrastructureError,
]);

/** Códigos que só podem marcar a transação como FAILED (nunca REJECTED). */
export function isInfrastructureFailure(code: FailureCode): boolean {
  return INFRASTRUCTURE_CODES.has(code);
}
