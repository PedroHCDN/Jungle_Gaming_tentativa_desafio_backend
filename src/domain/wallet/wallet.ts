import { LedgerDirection } from '../ledger/ledger-direction';
import { Money, MoneyProps } from '../money/money';
import {
  CurrencyMismatchError,
  InsufficientFundsError,
  InvalidAmountError,
  InvalidMoneyError,
} from '../shared/domain-error';

/** Estado persistido da wallet (usado só por `rehydrate`). */
export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: MoneyProps;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Descreve uma alteração de saldo já aplicada. É o insumo para criar o
 * `WalletLedgerEntry` correspondente: saldo e ledger nascem do mesmo dado.
 */
export interface BalanceMovement {
  readonly direction: LedgerDirection;
  readonly money: Money;
  readonly balanceBefore: Money;
  readonly balanceAfter: Money;
  /** Versão da wallet depois do movimento. */
  readonly walletVersion: number;
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  /**
   * Abre uma wallet com `version = 1`. O saldo inicial entra direto no
   * estado; o caso de uso grava a transação `OPENING` e o lançamento
   * `CREDIT` (balanceBefore = 0) na mesma transação SQL.
   */
  static open(props: {
    id: string;
    playerId: string;
    initialBalance: Money;
    now?: Date;
  }): Wallet {
    if (props.initialBalance.isNegative()) {
      throw new InvalidMoneyError('initial balance cannot be negative');
    }
    const now = props.now ?? new Date();
    return new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      now,
      now,
    );
  }

  /** Reconstrução a partir da persistência — não revalida regras. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      Money.from(state.balance),
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  /**
   * Debita `money`. Lança `InsufficientFundsError` se o saldo ficaria
   * negativo; nesse caso o estado da wallet permanece intacto.
   * O caso de uso decide o failureCode (aposta sem saldo vs. reversão
   * que deixaria saldo negativo) a partir do `kind` da transação.
   */
  debit(money: Money, at: Date): BalanceMovement {
    this.assertApplicable(money);
    if (this._balance.isLessThan(money)) {
      throw new InsufficientFundsError(
        this._balance.toString(),
        money.toString(),
      );
    }
    return this.apply(
      LedgerDirection.Debit,
      this._balance.subtract(money),
      money,
      at,
    );
  }

  credit(money: Money, at: Date): BalanceMovement {
    this.assertApplicable(money);
    return this.apply(
      LedgerDirection.Credit,
      this._balance.add(money),
      money,
      at,
    );
  }

  private apply(
    direction: LedgerDirection,
    balanceAfter: Money,
    money: Money,
    at: Date,
  ): BalanceMovement {
    const balanceBefore = this._balance;
    this._balance = balanceAfter;
    this._version += 1; // só incrementa quando o saldo muda
    this._updatedAt = at;
    return {
      direction,
      money,
      balanceBefore,
      balanceAfter,
      walletVersion: this._version,
    };
  }

  private assertApplicable(money: Money): void {
    this.assertSameCurrency(money);
    if (!money.isPositive()) {
      throw new InvalidAmountError();
    }
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}
