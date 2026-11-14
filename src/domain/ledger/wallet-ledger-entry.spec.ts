import { describe, expect, it } from 'bun:test';
import { Money } from '../money/money';
import {
  CurrencyMismatchError,
  InvalidLedgerEntryError,
} from '../shared/domain-error';
import { Wallet } from '../wallet/wallet';
import { ledgerBalance } from './ledger-balance';
import { LedgerDirection } from './ledger-direction';
import {
  CreateLedgerEntryProps,
  WalletLedgerEntry,
} from './wallet-ledger-entry';

const t0 = new Date('2026-01-01T00:00:00.000Z');
const t1 = new Date('2026-01-01T00:00:01.000Z');
const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

function props(
  overrides: Partial<CreateLedgerEntryProps> = {},
): CreateLedgerEntryProps {
  return {
    id: 'entry-1',
    walletId: 'wallet-1',
    transactionId: 'tx-1',
    direction: LedgerDirection.Debit,
    money: brl('25.00'),
    balanceBefore: brl('100.00'),
    balanceAfter: brl('75.00'),
    createdAt: t0,
    ...overrides,
  };
}

describe('WalletLedgerEntry.create', () => {
  it('cria lançamento de débito balanceado', () => {
    const entry = WalletLedgerEntry.create(props());
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.money.toString()).toBe('25.00');
    expect(entry.balanceBefore.toString()).toBe('100.00');
    expect(entry.balanceAfter.toString()).toBe('75.00');
    expect(entry.createdAt).toEqual(t0);
    expect(entry.isBalanced()).toBe(true);
  });

  it('cria lançamento de crédito balanceado', () => {
    const entry = WalletLedgerEntry.create(
      props({
        direction: LedgerDirection.Credit,
        balanceBefore: brl('75.00'),
        balanceAfter: brl('100.00'),
      }),
    );
    expect(entry.isBalanced()).toBe(true);
  });

  it('aceita o lançamento de abertura (saldo anterior zero)', () => {
    const entry = WalletLedgerEntry.create(
      props({
        direction: LedgerDirection.Credit,
        money: brl('1000.00'),
        balanceBefore: Money.zero('BRL'),
        balanceAfter: brl('1000.00'),
      }),
    );
    expect(entry.balanceBefore.isZero()).toBe(true);
  });

  it('aceita zerar o saldo exatamente', () => {
    expect(() =>
      WalletLedgerEntry.create(
        props({
          money: brl('100.00'),
          balanceBefore: brl('100.00'),
          balanceAfter: Money.zero('BRL'),
        }),
      ),
    ).not.toThrow();
  });

  it('rejeita aritmética errada, mesmo por 1 centavo', () => {
    expect(() =>
      WalletLedgerEntry.create(props({ balanceAfter: brl('75.01') })),
    ).toThrow(InvalidLedgerEntryError);
    expect(() =>
      WalletLedgerEntry.create(props({ balanceAfter: brl('74.99') })),
    ).toThrow(InvalidLedgerEntryError);
  });

  it('rejeita direção contraditória com os saldos', () => {
    // 100 -> 75 é débito; declarado como crédito deve falhar
    expect(() =>
      WalletLedgerEntry.create(props({ direction: LedgerDirection.Credit })),
    ).toThrow(InvalidLedgerEntryError);
    expect(() =>
      WalletLedgerEntry.create(
        props({
          direction: LedgerDirection.Debit,
          balanceBefore: brl('75.00'),
          balanceAfter: brl('100.00'),
        }),
      ),
    ).toThrow(InvalidLedgerEntryError);
  });

  it('rejeita valor zero ou negativo', () => {
    expect(() =>
      WalletLedgerEntry.create(
        props({
          money: Money.zero('BRL'),
          balanceBefore: brl('100.00'),
          balanceAfter: brl('100.00'),
        }),
      ),
    ).toThrow(InvalidLedgerEntryError);
    expect(() =>
      WalletLedgerEntry.create(
        props({ money: brl('25.00').negate(), balanceAfter: brl('125.00') }),
      ),
    ).toThrow(InvalidLedgerEntryError);
  });

  it('rejeita saldos negativos', () => {
    expect(() =>
      WalletLedgerEntry.create(
        props({
          money: brl('150.00'),
          balanceBefore: brl('100.00'),
          balanceAfter: brl('100.00').subtract(brl('150.00')),
        }),
      ),
    ).toThrow(InvalidLedgerEntryError);
  });

  it('rejeita moedas diferentes entre valor e saldos', () => {
    const usd = (amount: string) => Money.from({ amount, currency: 'USD' });
    expect(() =>
      WalletLedgerEntry.create(props({ money: usd('25.00') })),
    ).toThrow(InvalidLedgerEntryError);
    expect(() =>
      WalletLedgerEntry.create(props({ balanceAfter: usd('75.00') })),
    ).toThrow(InvalidLedgerEntryError);
  });

  it.each(['id', 'walletId', 'transactionId'] as const)(
    'rejeita %s vazio',
    (field) => {
      expect(() => WalletLedgerEntry.create(props({ [field]: '' }))).toThrow(
        InvalidLedgerEntryError,
      );
      expect(() => WalletLedgerEntry.create(props({ [field]: '  ' }))).toThrow(
        InvalidLedgerEntryError,
      );
    },
  );
});

describe('WalletLedgerEntry: imutabilidade estrutural', () => {
  it('a instância é congelada e atribuições lançam erro', () => {
    const entry = WalletLedgerEntry.create(props());
    expect(Object.isFrozen(entry)).toBe(true);

    const mutable = entry as unknown as Record<string, unknown>;
    expect(() => {
      mutable['direction'] = LedgerDirection.Credit;
    }).toThrow(TypeError);
    expect(() => {
      mutable['balanceAfter'] = brl('999.00');
    }).toThrow(TypeError);
    expect(() => {
      mutable['extra'] = 1;
    }).toThrow(TypeError);
    expect(entry.balanceAfter.toString()).toBe('75.00');
  });

  it('a classe não expõe nenhum método de mutação ou transição', () => {
    const methods = Object.getOwnPropertyNames(
      WalletLedgerEntry.prototype,
    ).sort();
    expect(methods).toEqual(['constructor', 'isBalanced']);
  });

  it('o rehydrate também devolve instância congelada', () => {
    const entry = WalletLedgerEntry.rehydrate({
      id: 'e',
      walletId: 'w',
      transactionId: 't',
      direction: LedgerDirection.Debit,
      money: { amount: '25.00', currency: 'BRL' },
      balanceBefore: { amount: '100.00', currency: 'BRL' },
      balanceAfter: { amount: '75.00', currency: 'BRL' },
      createdAt: t0,
    });
    expect(Object.isFrozen(entry)).toBe(true);
  });
});

describe('WalletLedgerEntry.rehydrate', () => {
  const corrupted = {
    id: 'e1',
    walletId: 'w1',
    transactionId: 't1',
    direction: LedgerDirection.Debit,
    money: { amount: '25.00', currency: 'BRL' },
    balanceBefore: { amount: '100.00', currency: 'BRL' },
    balanceAfter: { amount: '70.00', currency: 'BRL' }, // deveria ser 75.00
    createdAt: t0,
  };

  it('não revalida a aritmética, mas isBalanced() detecta a corrupção', () => {
    const entry = WalletLedgerEntry.rehydrate(corrupted);
    expect(entry.isBalanced()).toBe(false);
  });

  it('isBalanced() é true para dado íntegro', () => {
    const entry = WalletLedgerEntry.rehydrate({
      ...corrupted,
      balanceAfter: { amount: '75.00', currency: 'BRL' },
    });
    expect(entry.isBalanced()).toBe(true);
  });

  it('isBalanced() é false (sem lançar) quando as moedas divergem', () => {
    const entry = WalletLedgerEntry.rehydrate({
      ...corrupted,
      balanceAfter: { amount: '75.00', currency: 'USD' },
    });
    expect(entry.isBalanced()).toBe(false);
  });
});

describe('WalletLedgerEntry.fromMovement + Wallet', () => {
  it('cada movimento da Wallet vira um lançamento balanceado e encadeado', () => {
    const wallet = Wallet.open({
      id: 'wallet-1',
      playerId: 'player-1',
      initialBalance: brl('100.00'),
      now: t0,
    });
    const movements = [
      wallet.debit(brl('30.00'), t1),
      wallet.credit(brl('12.34'), t1),
      wallet.debit(brl('0.01'), t1),
    ];
    const entries = movements.map((movement, index) =>
      WalletLedgerEntry.fromMovement(movement, {
        id: `entry-${index}`,
        walletId: wallet.id,
        transactionId: `tx-${index}`,
        createdAt: t1,
      }),
    );

    for (const entry of entries) expect(entry.isBalanced()).toBe(true);
    for (let i = 1; i < entries.length; i++) {
      expect(
        entries[i]?.balanceBefore.equals(entries[i - 1]?.balanceAfter as Money),
      ).toBe(true);
    }
    expect(entries.at(-1)?.balanceAfter.equals(wallet.balance)).toBe(true);
  });
});

describe('ledgerBalance (invariante final dos testes)', () => {
  it('é zero para ledger vazio', () => {
    expect(ledgerBalance('BRL', []).toString()).toBe('0.00');
  });

  it('wallet.balance == saldo reconstruído pelo ledger (abertura + movimentos)', () => {
    const wallet = Wallet.open({
      id: 'wallet-1',
      playerId: 'player-1',
      initialBalance: brl('1000.00'),
      now: t0,
    });
    const opening = WalletLedgerEntry.create({
      id: 'entry-open',
      walletId: wallet.id,
      transactionId: 'tx-open',
      direction: LedgerDirection.Credit,
      money: brl('1000.00'),
      balanceBefore: Money.zero('BRL'),
      balanceAfter: brl('1000.00'),
      createdAt: t0,
    });
    const entries = [opening];
    const apply = (movement: ReturnType<Wallet['debit']>) =>
      entries.push(
        WalletLedgerEntry.fromMovement(movement, {
          id: `entry-${entries.length}`,
          walletId: wallet.id,
          transactionId: `tx-${entries.length}`,
          createdAt: t1,
        }),
      );

    apply(wallet.debit(brl('80.00'), t1));
    apply(wallet.credit(brl('160.00'), t1));
    apply(wallet.debit(brl('0.01'), t1));

    expect(ledgerBalance('BRL', entries).equals(wallet.balance)).toBe(true);
    expect(wallet.balance.toString()).toBe('1079.99');
  });

  it('lança CurrencyMismatchError se uma entrada for de outra moeda', () => {
    const usdEntry = WalletLedgerEntry.create(
      props({
        direction: LedgerDirection.Credit,
        money: Money.from({ amount: '5.00', currency: 'USD' }),
        balanceBefore: Money.from({ amount: '0.00', currency: 'USD' }),
        balanceAfter: Money.from({ amount: '5.00', currency: 'USD' }),
      }),
    );
    expect(() => ledgerBalance('BRL', [usdEntry])).toThrow(
      CurrencyMismatchError,
    );
  });
});
