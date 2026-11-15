/**
 * Política de espera por uma referência que ainda não chegou (mensagens fora
 * de ordem): `maxAttempts` buscas no total, com backoff exponencial.
 *
 * Com o padrão (5 tentativas, 1 s): a 1ª busca é na chegada, as seguintes
 * após 1 s, 2 s, 4 s e 8 s; se a 5ª também falhar a transação é rejeitada com
 * REFERENCE_NOT_FOUND. A janela total de espera é de 15 s.
 */
export interface PendingReferencePolicy {
  readonly maxAttempts: number;
  readonly initialDelayMs: number;
}

export const DEFAULT_PENDING_REFERENCE_POLICY: PendingReferencePolicy = {
  maxAttempts: 5,
  initialDelayMs: 1000,
};

/**
 * Quando tentar de novo depois de `failedAttempts` buscas sem achar a
 * referência. `undefined` quando as tentativas acabaram.
 */
export function nextAttemptAt(
  policy: PendingReferencePolicy,
  failedAttempts: number,
  now: Date,
): Date | undefined {
  if (failedAttempts >= policy.maxAttempts) return undefined;
  const delayMs = policy.initialDelayMs * 2 ** (failedAttempts - 1);
  return new Date(now.getTime() + delayMs);
}
