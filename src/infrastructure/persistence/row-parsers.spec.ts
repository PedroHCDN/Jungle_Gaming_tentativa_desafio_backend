import { describe, expect, it } from 'bun:test';
import { WagerTransactionKind } from '../../domain/wagering/wager-transaction-kind';
import {
  amount,
  enumValue,
  integer,
  optionalText,
  optionalTimestamp,
  PersistenceError,
  text,
  timestamp,
} from './row-parsers';

describe('row-parsers', () => {
  it('amount só aceita a string decimal do numeric(19,2)', () => {
    expect(amount({ a: '25.00' }, 'a')).toBe('25.00');
    expect(amount({ a: '99999999999999999.99' }, 'a')).toBe(
      '99999999999999999.99',
    );
    // um number (ex.: driver configurado com parseFloat) perderia precisão: erro explícito
    expect(() => amount({ a: 25 }, 'a')).toThrow(PersistenceError);
    expect(() => amount({ a: '25' }, 'a')).toThrow(PersistenceError);
    expect(() => amount({ a: '-1.00' }, 'a')).toThrow(PersistenceError);
    expect(() => amount({ a: null }, 'a')).toThrow(PersistenceError);
  });

  it('integer aceita number seguro ou string numérica', () => {
    expect(integer({ v: 3 }, 'v')).toBe(3);
    expect(integer({ v: '12' }, 'v')).toBe(12);
    expect(() => integer({ v: 1.5 }, 'v')).toThrow(PersistenceError);
    expect(() => integer({ v: '9007199254740993' }, 'v')).toThrow(
      PersistenceError,
    );
    expect(() => integer({ v: 'x' }, 'v')).toThrow(PersistenceError);
  });

  it('timestamp aceita Date ou string ISO e rejeita lixo', () => {
    const date = new Date('2026-01-01T00:00:00.000Z');
    expect(timestamp({ t: date }, 't')).toEqual(date);
    expect(timestamp({ t: '2026-01-01T00:00:00.000Z' }, 't')).toEqual(date);
    expect(() => timestamp({ t: 'ontem' }, 't')).toThrow(PersistenceError);
    expect(() => timestamp({ t: 123 }, 't')).toThrow(PersistenceError);
    expect(optionalTimestamp({ t: null }, 't')).toBeUndefined();
  });

  it('enumValue rejeita valores fora do enum', () => {
    expect(enumValue(WagerTransactionKind, { k: 'BET' }, 'k')).toBe(
      WagerTransactionKind.Bet,
    );
    expect(() => enumValue(WagerTransactionKind, { k: 'bet' }, 'k')).toThrow(
      PersistenceError,
    );
  });

  it('text e optionalText', () => {
    expect(text({ s: 'a' }, 's')).toBe('a');
    expect(() => text({ s: 1 }, 's')).toThrow(PersistenceError);
    expect(optionalText({ s: null }, 's')).toBeUndefined();
    expect(optionalText({}, 's')).toBeUndefined();
  });
});
