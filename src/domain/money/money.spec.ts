import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CurrencyMismatchError,
  InvalidMoneyError,
  MoneyOverflowError,
} from '../shared/domain-error.js';
import { Money } from './money';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

describe('Money.from', () => {
  it('normaliza para escala 2', () => {
    expect(brl('25').toString()).toBe('25.00');
    expect(brl('25.5').toString()).toBe('25.50');
    expect(brl('25.50').toString()).toBe('25.50');
    expect(brl('0.05').toString()).toBe('0.05');
    expect(brl('0').toString()).toBe('0.00');
  });

  it('aceita o maior valor de numeric(19,2)', () => {
    expect(brl('99999999999999999.99').toString()).toBe('99999999999999999.99');
  });

  it.each([
    '',
    ' ',
    'NaN',
    'Infinity',
    '-Infinity',
    '1e3',
    '1E3',
    '1e-2',
    '0x10',
    '-1.00',
    '+1.00',
    '-0.00',
    '1.234',
    '1.005',
    '1,50',
    '1.000,00',
    '1_000.00',
    '.50',
    '1.',
    '00.50',
    '01.00',
    ' 1.00',
    '1.00 ',
    '1 .00',
    '100000000000000000.00', // 18 dígitos inteiros
  ])('rejeita amount inválido: %p', (amount) => {
    expect(() => brl(amount)).toThrow(InvalidMoneyError);
  });

  it('rejeita number, bigint, null e undefined em amount', () => {
    for (const amount of [
      25,
      25.5,
      NaN,
      Infinity,
      25n,
      null,
      undefined,
      {},
      [],
    ]) {
      expect(() =>
        Money.from({ amount: amount as string, currency: 'BRL' }),
      ).toThrow(InvalidMoneyError);
    }
  });

  it('rejeita moeda inválida', () => {
    for (const currency of ['', 'br', 'brl', 'BRLL', 'B1L', ' BRL', 'R$']) {
      expect(() => Money.from({ amount: '1.00', currency })).toThrow(
        InvalidMoneyError,
      );
    }
    expect(() =>
      Money.from({ amount: '1.00', currency: 986 as unknown as string }),
    ).toThrow(InvalidMoneyError);
  });

  it('rejeita props nulas', () => {
    expect(() => Money.from(null as never)).toThrow(InvalidMoneyError);
  });
});

describe('Money aritmética exata', () => {
  it('não tem erro de ponto flutuante (0.10 + 0.20 == 0.30)', () => {
    expect(brl('0.10').add(brl('0.20')).equals(brl('0.30'))).toBe(true);
    expect(brl('0.10').add(brl('0.20')).toString()).toBe('0.30');
  });

  it('soma 10.000 centavos sem deriva', () => {
    let total = Money.zero('BRL');
    for (let i = 0; i < 10_000; i++) total = total.add(brl('0.01'));
    expect(total.toString()).toBe('100.00');
  });

  it('subtract pode resultar em negativo', () => {
    const result = brl('1.00').subtract(brl('2.50'));
    expect(result.isNegative()).toBe(true);
    expect(result.toString()).toBe('-1.50');
    expect(result.negate().toString()).toBe('1.50');
  });

  it('negate de zero é zero', () => {
    expect(Money.zero('BRL').negate().isZero()).toBe(true);
    expect(Money.zero('BRL').negate().toString()).toBe('0.00');
  });

  it('é imutável: operações não alteram a instância original', () => {
    const a = brl('10.00');
    const b = brl('3.00');
    a.add(b);
    a.subtract(b);
    a.negate();
    expect(a.toString()).toBe('10.00');
    expect(b.toString()).toBe('3.00');
  });

  it('lança overflow acima de numeric(19,2)', () => {
    const max = brl('99999999999999999.99');
    expect(() => max.add(brl('0.01'))).toThrow(MoneyOverflowError);
    expect(() => max.negate().subtract(brl('0.01'))).toThrow(
      MoneyOverflowError,
    );
  });
});

describe('Money comparações', () => {
  it('isZero / isPositive / isNegative', () => {
    expect(brl('0').isZero()).toBe(true);
    expect(brl('0.01').isPositive()).toBe(true);
    expect(brl('0.01').isNegative()).toBe(false);
    expect(brl('1.00').subtract(brl('2.00')).isNegative()).toBe(true);
  });

  it('isLessThan / isGreaterThan / equals', () => {
    expect(brl('1.00').isLessThan(brl('1.01'))).toBe(true);
    expect(brl('1.01').isLessThan(brl('1.00'))).toBe(false);
    expect(brl('1.00').isLessThan(brl('1.00'))).toBe(false);
    expect(brl('1.01').isGreaterThan(brl('1.00'))).toBe(true);
    expect(brl('1').equals(brl('1.00'))).toBe(true);
  });
});

describe('Money conflito de moeda', () => {
  const usd = Money.from({ amount: '1.00', currency: 'USD' });

  it('add, subtract e comparações lançam CurrencyMismatchError', () => {
    expect(() => brl('1.00').add(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').subtract(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').isLessThan(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').isGreaterThan(usd)).toThrow(CurrencyMismatchError);
  });

  it('equals entre moedas diferentes é false e não lança', () => {
    expect(brl('1.00').equals(usd)).toBe(false);
  });
});

describe('Money serialização', () => {
  it('toJSON devolve MoneyProps com string decimal', () => {
    const json = brl('25').toJSON();
    expect(json).toEqual({ amount: '25.00', currency: 'BRL' });
    expect(typeof json.amount).toBe('string');
  });

  it('JSON.stringify produz o contrato de API', () => {
    expect(JSON.stringify({ money: brl('975') })).toBe(
      '{"money":{"amount":"975.00","currency":"BRL"}}',
    );
  });

  it('round-trip from(toJSON()) preserva o valor', () => {
    for (const amount of [
      '0.00',
      '0.01',
      '1.10',
      '999.99',
      '99999999999999999.99',
    ]) {
      const money = brl(amount);
      expect(Money.from(money.toJSON()).equals(money)).toBe(true);
    }
  });
});

describe('Money: guarda contra number/float (falha eliminatória)', () => {
  it('o código-fonte do Money não usa number, parseFloat, Number() nem Math', () => {
    const source = readFileSync(join(__dirname, 'money.ts'), 'utf8')
      // ignora comentários para não acusar texto explicativo
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');

    expect(source).not.toMatch(/:\s*number\b/);
    expect(source).not.toMatch(/\bparseFloat\b/);
    expect(source).not.toMatch(/\bparseInt\b/);
    expect(source).not.toMatch(/\bNumber\s*\(/);
    expect(source).not.toMatch(/\bMath\./);
    expect(source).not.toMatch(/\bDecimal\b/);
  });
});
