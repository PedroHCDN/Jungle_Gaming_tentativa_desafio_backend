import { describe, expect, it } from 'bun:test';
import { LedgerDirection } from '../ledger/ledger-direction';
import { Money } from '../money/money';
import {
  CurrencyMismatchError,
  InsufficientFundsError,
  InvalidAmountError,
  InvalidMoneyError,
} from '../shared/domain-error';
import { Wallet } from './wallet';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const t0 = new Date('2026-01-01T00:00:00.000Z');
const t1 = new Date('2026-01-01T00:00:01.000Z');
const t2 = new Date('2026-01-01T00:00:02.000Z');

const openWallet = (initial = '100.00') =>
  Wallet.open({
    id: 'w1',
    playerId: 'p1',
    initialBalance: brl(initial),
    now: t0,
  });

describe('Wallet.open', () => {
  it('começa com version 1, saldo inicial e moeda derivada do saldo', () => {
    const wallet = openWallet('1000.00');
    expect(wallet.version).toBe(1);
    expect(wallet.balance.toString()).toBe('1000.00');
    expect(wallet.currency).toBe('BRL');
    expect(wallet.createdAt).toEqual(t0);
    expect(wallet.updatedAt).toEqual(t0);
  });

  it('aceita saldo inicial zero', () => {
    expect(openWallet('0.00').balance.isZero()).toBe(true);
  });

  it('rejeita saldo inicial negativo', () => {
    const negative = brl('1.00').subtract(brl('2.00'));
    expect(() =>
      Wallet.open({ id: 'w1', playerId: 'p1', initialBalance: negative }),
    ).toThrow(InvalidMoneyError);
  });
});

describe('Wallet.debit', () => {
  it('debita e devolve o movimento com saldo antes/depois', () => {
    const wallet = openWallet('100.00');
    const movement = wallet.debit(brl('25.00'), t1);

    expect(movement.direction).toBe(LedgerDirection.Debit);
    expect(movement.money.toString()).toBe('25.00');
    expect(movement.balanceBefore.toString()).toBe('100.00');
    expect(movement.balanceAfter.toString()).toBe('75.00');
    expect(movement.walletVersion).toBe(2);
    expect(wallet.balance.toString()).toBe('75.00');
    expect(wallet.updatedAt).toEqual(t1);
  });

  it('permite zerar a wallet exatamente', () => {
    const wallet = openWallet('80.00');
    wallet.debit(brl('80.00'), t1);
    expect(wallet.balance.toString()).toBe('0.00');
  });

  it('rejeita saldo insuficiente sem alterar o estado', () => {
    const wallet = openWallet('100.00');
    expect(() => wallet.debit(brl('100.01'), t1)).toThrow(
      InsufficientFundsError,
    );
    expect(wallet.balance.toString()).toBe('100.00');
    expect(wallet.version).toBe(1);
    expect(wallet.updatedAt).toEqual(t0);
  });

  it('cenário da seção 8: segunda aposta de 80 com saldo 100 é rejeitada', () => {
    const wallet = openWallet('100.00');
    wallet.debit(brl('80.00'), t1);
    expect(() => wallet.debit(brl('80.00'), t2)).toThrow(
      InsufficientFundsError,
    );
    expect(wallet.balance.toString()).toBe('20.00');
    expect(wallet.version).toBe(2);
  });

  it('rejeita valor zero e negativo', () => {
    const wallet = openWallet();
    expect(() => wallet.debit(Money.zero('BRL'), t1)).toThrow(
      InvalidAmountError,
    );
    expect(() => wallet.debit(brl('1.00').negate(), t1)).toThrow(
      InvalidAmountError,
    );
    expect(wallet.version).toBe(1);
  });

  it('rejeita moeda diferente da wallet', () => {
    const wallet = openWallet();
    const usd = Money.from({ amount: '1.00', currency: 'USD' });
    expect(() => wallet.debit(usd, t1)).toThrow(CurrencyMismatchError);
    expect(wallet.balance.toString()).toBe('100.00');
    expect(wallet.version).toBe(1);
  });
});

describe('Wallet.credit', () => {
  it('credita e devolve o movimento', () => {
    const wallet = openWallet('100.00');
    const movement = wallet.credit(brl('0.01'), t1);

    expect(movement.direction).toBe(LedgerDirection.Credit);
    expect(movement.balanceBefore.toString()).toBe('100.00');
    expect(movement.balanceAfter.toString()).toBe('100.01');
    expect(movement.walletVersion).toBe(2);
    expect(wallet.balance.toString()).toBe('100.01');
  });

  it('rejeita valor zero, negativo e moeda diferente', () => {
    const wallet = openWallet();
    expect(() => wallet.credit(Money.zero('BRL'), t1)).toThrow(
      InvalidAmountError,
    );
    expect(() => wallet.credit(brl('1.00').negate(), t1)).toThrow(
      InvalidAmountError,
    );
    expect(() =>
      wallet.credit(Money.from({ amount: '1.00', currency: 'USD' }), t1),
    ).toThrow(CurrencyMismatchError);
    expect(wallet.version).toBe(1);
  });
});

describe('Wallet.version', () => {
  it('incrementa só quando o saldo muda', () => {
    const wallet = openWallet('100.00');
    expect(wallet.version).toBe(1);
    wallet.credit(brl('10.00'), t1);
    expect(wallet.version).toBe(2);
    wallet.debit(brl('5.00'), t1);
    expect(wallet.version).toBe(3);
    expect(() => wallet.debit(brl('999.00'), t1)).toThrow();
    expect(wallet.version).toBe(3);
  });
});

describe('Wallet invariante de ledger', () => {
  it('a sequência de movimentos reconstrói o saldo e encadeia before/after', () => {
    const wallet = openWallet('100.00');
    const movements = [
      wallet.debit(brl('30.00'), t1),
      wallet.credit(brl('12.34'), t1),
      wallet.debit(brl('0.01'), t2),
    ];

    let rebuilt = brl('100.00');
    for (const m of movements) {
      expect(m.balanceBefore.equals(rebuilt)).toBe(true);
      rebuilt =
        m.direction === LedgerDirection.Debit
          ? rebuilt.subtract(m.money)
          : rebuilt.add(m.money);
      expect(m.balanceAfter.equals(rebuilt)).toBe(true);
    }
    expect(wallet.balance.equals(rebuilt)).toBe(true);
    expect(wallet.balance.toString()).toBe('82.33');
  });
});

describe('Wallet.rehydrate', () => {
  it('reconstrói o estado persistido sem alterar version', () => {
    const wallet = Wallet.rehydrate({
      id: 'w9',
      playerId: 'p9',
      currency: 'BRL',
      balance: { amount: '42.50', currency: 'BRL' },
      version: 7,
      createdAt: t0,
      updatedAt: t1,
    });
    expect(wallet.id).toBe('w9');
    expect(wallet.balance.toString()).toBe('42.50');
    expect(wallet.version).toBe(7);
    expect(wallet.updatedAt).toEqual(t1);
  });
});
