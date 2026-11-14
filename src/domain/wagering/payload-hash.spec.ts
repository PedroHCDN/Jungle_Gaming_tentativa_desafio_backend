import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  canonicalJson,
  computePayloadHash,
  PayloadHashInput,
} from './payload-hash';

const base: PayloadHashInput = {
  providerId: 'provider-a',
  externalTransactionId: 'transaction-123',
  playerId: 'player-1',
  walletId: 'wallet-1',
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind: 'BET',
  money: { amount: '25.00', currency: 'BRL' },
};

describe('canonicalJson', () => {
  it('ordena as chaves em todos os níveis e não usa espaços', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(
      '{"a":{"c":3,"d":2},"b":1}',
    );
  });

  it('omite valores undefined e mantém a ordem dos arrays', () => {
    expect(canonicalJson({ a: undefined, b: [3, 1, 2] })).toBe('{"b":[3,1,2]}');
  });

  it('escapa strings como JSON', () => {
    expect(canonicalJson({ k: 'a"b' })).toBe('{"k":"a\\"b"}');
  });
});

describe('computePayloadHash', () => {
  it('é SHA-256 hex do JSON canônico documentado', () => {
    const expectedCanonical =
      '{"externalTransactionId":"transaction-123","gameId":"fortune-chimp",' +
      '"kind":"BET","money":{"amount":"25.00","currency":"BRL"},"playerId":"player-1",' +
      '"providerId":"provider-a","roundId":"round-987","walletId":"wallet-1"}';
    const expected = createHash('sha256')
      .update(expectedCanonical, 'utf8')
      .digest('hex');
    expect(computePayloadHash(base)).toBe(expected);
    expect(computePayloadHash(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('não depende da ordem das chaves de entrada', () => {
    const reordered = {
      money: { currency: 'BRL', amount: '25.00' },
      kind: 'BET',
      gameId: 'fortune-chimp',
      roundId: 'round-987',
      walletId: 'wallet-1',
      playerId: 'player-1',
      externalTransactionId: 'transaction-123',
      providerId: 'provider-a',
    } as PayloadHashInput;
    expect(computePayloadHash(reordered)).toBe(computePayloadHash(base));
  });

  it('normaliza o valor monetário ("25" == "25.00")', () => {
    const short = { ...base, money: { amount: '25', currency: 'BRL' } };
    expect(computePayloadHash(short)).toBe(computePayloadHash(base));
  });

  it('muda quando qualquer campo de negócio muda', () => {
    const original = computePayloadHash(base);
    const variants: PayloadHashInput[] = [
      { ...base, providerId: 'provider-b' },
      { ...base, externalTransactionId: 'transaction-124' },
      { ...base, playerId: 'player-2' },
      { ...base, walletId: 'wallet-2' },
      { ...base, roundId: 'round-1' },
      { ...base, gameId: 'other-game' },
      { ...base, kind: 'WIN' },
      { ...base, money: { amount: '25.01', currency: 'BRL' } },
      { ...base, money: { amount: '25.00', currency: 'USD' } },
      { ...base, referenceExternalTransactionId: 'transaction-100' },
    ];
    for (const variant of variants) {
      expect(computePayloadHash(variant)).not.toBe(original);
    }
  });

  it('referência ausente e undefined geram o mesmo hash', () => {
    expect(
      computePayloadHash({
        ...base,
        referenceExternalTransactionId: undefined,
      }),
    ).toBe(computePayloadHash(base));
  });
});
