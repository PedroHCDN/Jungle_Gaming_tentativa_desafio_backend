import {
  CurrencyMismatchError,
  InvalidMoneyError,
  MoneyOverflowError,
} from '../shared/domain-error';

/** Contrato de entrada/saída: valor como string decimal, nunca como número. */
export interface MoneyProps {
  amount: string; // ex.: "25.00"
  currency: string; // ISO-4217, ex.: "BRL"
}

const SCALE = 2;
const MINOR_PER_MAJOR = 100n;
/** numeric(19,2): 17 dígitos inteiros + 2 decimais => |minor| <= 10^19 - 1. */
const MAX_ABS_MINOR = 10n ** 19n - 1n;

/** Sem zeros à esquerda, 1 a 17 dígitos inteiros, 0 a 2 decimais. */
const AMOUNT_PATTERN = /^(0|[1-9]\d{0,16})(?:\.(\d{1,2}))?$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/**
 * Valor monetário imutável.
 *
 * Guarda o valor em unidades menores (centavos) como `bigint`: nenhuma
 * operação passa por `number`/`float`, então a aritmética é exata.
 * Todo método retorna uma nova instância.
 */
export class Money {
  private constructor(
    private readonly minor: bigint,
    public readonly currency: string,
  ) {
    if (minor > MAX_ABS_MINOR || minor < -MAX_ABS_MINOR) {
      throw new MoneyOverflowError();
    }
  }

  /**
   * Parser estrito para contratos de entrada.
   * Rejeita: não-string (inclusive `number`), vazio, NaN, Infinity, notação
   * científica, sinal (+/-), separador de milhar, vírgula decimal, zeros à
   * esquerda e mais de 2 casas decimais. Aceita "25", "25.5" e "25.50" e
   * normaliza para escala 2.
   */
  static from(props: MoneyProps): Money {
    if (props === null || typeof props !== 'object') {
      throw new InvalidMoneyError('Money props must be an object');
    }
    const { amount, currency } = props as {
      amount: unknown;
      currency: unknown;
    };

    if (typeof amount !== 'string') {
      throw new InvalidMoneyError('amount must be a decimal string');
    }
    if (typeof currency !== 'string' || !CURRENCY_PATTERN.test(currency)) {
      throw new InvalidMoneyError(
        'currency must be a 3-letter uppercase ISO-4217 code',
      );
    }

    const match = AMOUNT_PATTERN.exec(amount);
    if (!match) {
      throw new InvalidMoneyError(
        'amount must be a non-negative decimal string with at most 2 decimal places',
      );
    }

    const major = BigInt(match[1] as string);
    const fraction = BigInt((match[2] ?? '').padEnd(SCALE, '0'));
    return new Money(major * MINOR_PER_MAJOR + fraction, currency);
  }

  static zero(currency: string): Money {
    if (!CURRENCY_PATTERN.test(currency)) {
      throw new InvalidMoneyError(
        'currency must be a 3-letter uppercase ISO-4217 code',
      );
    }
    return new Money(0n, currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minor + other.minor, this.currency);
  }

  /** Pode resultar em valor negativo; quem protege o saldo é a Wallet. */
  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minor - other.minor, this.currency);
  }

  negate(): Money {
    return new Money(-this.minor, this.currency);
  }

  isZero(): boolean {
    return this.minor === 0n;
  }

  isPositive(): boolean {
    return this.minor > 0n;
  }

  isNegative(): boolean {
    return this.minor < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minor < other.minor;
  }

  isGreaterThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minor > other.minor;
  }

  /** Moedas diferentes nunca são iguais (não lança). */
  equals(other: Money): boolean {
    return this.currency === other.currency && this.minor === other.minor;
  }

  toJSON(): MoneyProps {
    return { amount: this.toString(), currency: this.currency };
  }

  /** String decimal com escala fixa de 2 casas, ex.: "25.00" ou "-5.00". */
  toString(): string {
    const negative = this.minor < 0n;
    const abs = negative ? -this.minor : this.minor;
    const major = abs / MINOR_PER_MAJOR;
    const fraction = (abs % MINOR_PER_MAJOR).toString().padStart(SCALE, '0');
    return `${negative ? '-' : ''}${major.toString()}.${fraction}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }
}
