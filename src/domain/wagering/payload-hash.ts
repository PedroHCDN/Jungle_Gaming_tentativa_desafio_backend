import { createHash } from 'node:crypto';
import { Money, MoneyProps } from '../money/money';

/**
 * Campos de negócio que entram no hash. O header Idempotency-Key e qualquer
 * metadado de transporte (messageId, occurredAt, ...) ficam de fora.
 */
export interface PayloadHashInput {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

/**
 * JSON canônico: chaves ordenadas (ordem lexicográfica por unidade de código
 * UTF-16) em todos os níveis, sem espaços, valores `undefined` omitidos.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item === undefined ? null : item)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
  return `{${entries.join(',')}}`;
}

/**
 * Algoritmo: SHA-256 (hex minúsculo) sobre os bytes UTF-8 do JSON canônico
 * dos campos de negócio. O valor monetário é normalizado via `Money`, então
 * "25", "25.5" e "25.50" geram o mesmo hash que "25.00"/"25.50".
 */
export function computePayloadHash(input: PayloadHashInput): string {
  const canonical = canonicalJson({
    providerId: input.providerId,
    externalTransactionId: input.externalTransactionId,
    playerId: input.playerId,
    walletId: input.walletId,
    roundId: input.roundId,
    gameId: input.gameId,
    kind: input.kind,
    money: Money.from(input.money).toJSON(),
    referenceExternalTransactionId: input.referenceExternalTransactionId,
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}
