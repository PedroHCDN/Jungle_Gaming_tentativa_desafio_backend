import { Money, MoneyProps } from '../money/money';
import { InvalidLedgerEntryError } from '../shared/domain-error';
import type { BalanceMovement } from '../wallet/wallet';
import { LedgerDirection } from './ledger-direction';

const MAX_ID_LENGTH = 255;

export interface CreateLedgerEntryProps {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt?: Date;
}

export interface LedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  createdAt: Date;
}

/**
 * Lançamento imutável do ledger.
 *
 * A imutabilidade é estrutural: todos os campos são `readonly`, a instância é
 * congelada e a classe não tem nenhum método de transição. Corrigir um erro
 * significa criar um novo lançamento de compensação, nunca alterar um antigo.
 */
export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly createdAt: Date,
  ) {
    Object.freeze(this);
  }

  /**
   * Valida a aritmética do lançamento (`balanceBefore ± money === balanceAfter`),
   * a coerência de moeda e os limites (valor positivo, saldos não negativos).
   */
  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    for (const [field, value] of [
      ['id', props.id],
      ['walletId', props.walletId],
      ['transactionId', props.transactionId],
    ] as const) {
      if (
        typeof value !== 'string' ||
        value.trim() === '' ||
        value.length > MAX_ID_LENGTH
      ) {
        throw new InvalidLedgerEntryError(
          `${field} must be a non-empty string of at most ${MAX_ID_LENGTH} characters`,
        );
      }
    }

    const { money, balanceBefore, balanceAfter, direction } = props;

    if (
      money.currency !== balanceBefore.currency ||
      money.currency !== balanceAfter.currency
    ) {
      throw new InvalidLedgerEntryError(
        'money, balanceBefore and balanceAfter must share a currency',
      );
    }
    if (!money.isPositive()) {
      throw new InvalidLedgerEntryError(
        'a ledger entry must move an amount greater than zero',
      );
    }
    if (balanceBefore.isNegative() || balanceAfter.isNegative()) {
      throw new InvalidLedgerEntryError(
        'balances in a ledger entry cannot be negative',
      );
    }
    if (
      !WalletLedgerEntry.expectedAfter(direction, balanceBefore, money).equals(
        balanceAfter,
      )
    ) {
      throw new InvalidLedgerEntryError(
        `unbalanced entry: ${balanceBefore.toString()} ${direction} ${money.toString()} != ${balanceAfter.toString()}`,
      );
    }

    return new WalletLedgerEntry(
      props.id,
      props.walletId,
      props.transactionId,
      direction,
      money,
      balanceBefore,
      balanceAfter,
      props.createdAt ?? new Date(),
    );
  }

  /**
   * Cria o lançamento a partir de um movimento já aplicado pela `Wallet`:
   * saldo e ledger nascem do mesmo dado, então não podem divergir.
   */
  static fromMovement(
    movement: BalanceMovement,
    context: {
      id: string;
      walletId: string;
      transactionId: string;
      createdAt?: Date;
    },
  ): WalletLedgerEntry {
    return WalletLedgerEntry.create({
      id: context.id,
      walletId: context.walletId,
      transactionId: context.transactionId,
      direction: movement.direction,
      money: movement.money,
      balanceBefore: movement.balanceBefore,
      balanceAfter: movement.balanceAfter,
      createdAt: context.createdAt,
    });
  }

  /** Reconstrução a partir da persistência — não revalida a aritmética. */
  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      Money.from(state.money),
      Money.from(state.balanceBefore),
      Money.from(state.balanceAfter),
      state.createdAt,
    );
  }

  /** `balanceBefore ± money === balanceAfter`. Útil para auditar dados reidratados. */
  isBalanced(): boolean {
    if (
      this.money.currency !== this.balanceBefore.currency ||
      this.money.currency !== this.balanceAfter.currency
    ) {
      return false;
    }
    return WalletLedgerEntry.expectedAfter(
      this.direction,
      this.balanceBefore,
      this.money,
    ).equals(this.balanceAfter);
  }

  private static expectedAfter(
    direction: LedgerDirection,
    balanceBefore: Money,
    money: Money,
  ): Money {
    switch (direction) {
      case LedgerDirection.Debit:
        return balanceBefore.subtract(money);
      case LedgerDirection.Credit:
        return balanceBefore.add(money);
    }
  }
}
